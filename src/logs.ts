/**
 * `quickflo logs` — the platform observability surface. Wraps the portal
 * `POST /logs/search` endpoint (the same one that backs the Logs explorer UI)
 * so an agent can query the unified log stream from the terminal: workflow logs
 * (core.log), step errors, connection failures, trigger firings, and audit
 * events, all filterable by the same facets the UI exposes.
 *
 * Three surfaces:
 *   - runLogsSearch  — the main query (facet flags → structured filter body),
 *     with `--follow` for a poll-based live tail mirroring the UI's cadence.
 *   - runLogsFacets  — just the sidebar counts, so an agent can discover the
 *     filter space (which channels / providers / tags exist) before drilling in.
 *
 * The reveal endpoint (audited click-to-reveal of a redacted field) is
 * deliberately not surfaced in v1.
 *
 * Table to stdout, banner / counts to stderr (the standard CLI split). `-j`
 * emits the raw entries (search) or the raw facets object (facets).
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession, type OpenSessionOptions } from './session.ts';
import { parseDuration } from './workflows-executions-shared.ts';
import { isStdoutTTY } from './tty.ts';
import { TimeoutError, UserError } from './errors.ts';

// Mirrors libs/logging logs-query.types.ts. Kept as a local structural type so
// the CLI has zero coupling to the server package (it talks HTTP/JSON only).
const LOG_SOURCES = [
  'workflow',
  'connection',
  'event-receiver',
  'integration-sync',
  'audit',
  'trigger',
] as const;
type LogSource = (typeof LOG_SOURCES)[number];

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

interface LogEntry {
  id: string;
  organizationId: string;
  source: LogSource;
  channel: string;
  level: LogLevel;
  origin: string;
  timestamp: string;
  message: string;
  workflowId: string;
  workflowName: string;
  executionId: string;
  stepId: string;
  connectionId: string;
  connectionName: string;
  triggerId: string;
  instanceId: string;
  provider: string;
  eventId: string;
  actorUserId: string;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  sensitivity: string;
  data: Record<string, unknown>;
  tags: string[];
  redactedPaths: string[];
}

interface LogFacetCount {
  value: string;
  count: number;
}

interface LogFacets {
  source: LogFacetCount[];
  level: LogFacetCount[];
  channel: LogFacetCount[];
  provider: LogFacetCount[];
  origin: LogFacetCount[];
  tags: LogFacetCount[];
}

interface LogsSearchResult {
  entries: LogEntry[];
  facets: LogFacets;
  histogram: unknown[];
  hasMore: boolean;
}

/** The structured filter body POSTed to /logs/search (mirrors logsSearchSchema). */
interface LogsSearchBody {
  sources?: LogSource[];
  level?: LogLevel[];
  channels?: string[];
  providers?: string[];
  origins?: string[];
  id?: string;
  workflowId?: string;
  executionId?: string;
  connectionId?: string;
  connectionName?: string;
  triggerId?: string;
  instanceId?: string;
  tags?: string[];
  text?: string[];
  dataFilters?: Array<{ path: string; value: string }>;
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
}

export interface LogsSearchOptions extends OpenSessionOptions {
  source?: string[];
  level?: string[];
  channel?: string[];
  provider?: string[];
  origin?: string[];
  tag?: string[];
  workflow?: string;
  execution?: string;
  connection?: string;
  connectionName?: string;
  trigger?: string;
  instance?: string;
  id?: string;
  search?: string[];
  data?: string[];
  since?: string;
  from?: string;
  to?: string;
  limit?: number;
  all?: boolean;
  follow?: boolean;
  interval?: number;
  timeout?: number;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

/** Split repeatable flags that also accept comma-separated values (e.g. `--level warn,error`). */
function splitCsv(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const out = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function validateEnum<T extends string>(
  values: string[] | undefined,
  allowed: readonly T[],
  flag: string,
): T[] | undefined {
  if (!values) return undefined;
  for (const v of values) {
    if (!allowed.includes(v as T)) {
      throw new UserError(
        `Invalid ${flag} "${v}". Allowed: ${allowed.join(', ')}.`,
      );
    }
  }
  return values as T[];
}

/** Parse repeatable `--data <path>:<value>` into dataFilters (first colon splits). */
function parseDataFilters(
  values: string[] | undefined,
): Array<{ path: string; value: string }> | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((expr) => {
    const i = expr.indexOf(':');
    if (i <= 0) {
      throw new UserError(`Invalid --data "${expr}". Expected <path>:<value>.`);
    }
    return { path: expr.slice(0, i), value: expr.slice(i + 1) };
  });
}

/** Build the /logs/search body from CLI options (sans the cursor, which paging owns). */
export function buildSearchBody(opts: LogsSearchOptions): LogsSearchBody {
  const body: LogsSearchBody = {};
  const sources = validateEnum(splitCsv(opts.source), LOG_SOURCES, '--source');
  if (sources) body.sources = sources;
  const levels = validateEnum(splitCsv(opts.level), LOG_LEVELS, '--level');
  if (levels) body.level = levels;
  const channels = splitCsv(opts.channel);
  if (channels) body.channels = channels;
  const providers = splitCsv(opts.provider);
  if (providers) body.providers = providers;
  const origins = splitCsv(opts.origin);
  if (origins) body.origins = origins;
  const tags = splitCsv(opts.tag);
  if (tags) body.tags = tags;
  if (opts.workflow) body.workflowId = opts.workflow;
  if (opts.execution) body.executionId = opts.execution;
  if (opts.connection) body.connectionId = opts.connection;
  if (opts.connectionName) body.connectionName = opts.connectionName;
  if (opts.trigger) body.triggerId = opts.trigger;
  if (opts.instance) body.instanceId = opts.instance;
  if (opts.id) body.id = opts.id;
  if (opts.search && opts.search.length > 0) body.text = opts.search;
  const dataFilters = parseDataFilters(opts.data);
  if (dataFilters) body.dataFilters = dataFilters;

  // Time window. `--since` is shorthand for `from = now - duration`; explicit
  // `--from`/`--to` win when supplied. The server defaults `from` to a lookback
  // window when none is given, so leaving it unset is fine.
  if (opts.from) {
    body.from = opts.from;
  } else if (opts.since) {
    body.from = new Date(Date.now() - parseDuration(opts.since)).toISOString();
  }
  if (opts.to) body.to = opts.to;

  if (opts.limit !== undefined) body.limit = opts.limit;
  return body;
}

async function search(client: ApiClient, body: LogsSearchBody): Promise<LogsSearchResult> {
  return await apiFetch<LogsSearchResult>(client, '/logs/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function colorLevel(level: string): string {
  if (level === 'error') return colors.red(level.toUpperCase());
  if (level === 'warn') return colors.yellow(level.toUpperCase());
  if (level === 'info') return colors.blue(level.toUpperCase());
  return colors.dim(level.toUpperCase());
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** `2026-06-22 23:14:13` (drop the date when it matches today, like a tail). */
function formatTs(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 23) : '—';
}

function formatRow(e: LogEntry, channelWidth: number): string {
  return [
    colors.dim(formatTs(e.timestamp).padEnd(23)),
    e.source.padEnd(16),
    truncate(e.channel || '—', channelWidth).padEnd(channelWidth),
    colorLevel(e.level).padEnd(15), // ANSI-aware budget for a 5-char level
    e.message,
  ].join('  ');
}

function printTable(entries: LogEntry[]): void {
  if (entries.length === 0) {
    console.log(colors.dim('(no log entries)'));
    return;
  }
  const channelWidth = Math.min(
    24,
    Math.max(7, ...entries.map((e) => (e.channel ?? '').length)),
  );
  const header = [
    'TIMESTAMP'.padEnd(23),
    'SOURCE'.padEnd(16),
    'CHANNEL'.padEnd(channelWidth),
    'LEVEL'.padEnd(5),
    'MESSAGE',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const e of entries) console.log(formatRow(e, channelWidth));
}

export async function runLogsSearch(opts: LogsSearchOptions): Promise<void> {
  const { client } = await openSession(opts, 'logs search');
  const body = buildSearchBody(opts);

  if (opts.follow) {
    await followLogs(client, opts, body);
    return;
  }

  const pageSize = opts.limit ?? 200;
  const all = opts.all ?? false;
  const entries: LogEntry[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await search(client, { ...body, limit: pageSize, before: cursor });
    entries.push(...page.entries);
    if (!all || !page.hasMore || page.entries.length === 0) break;
    cursor = page.entries[page.entries.length - 1].timestamp;
  }

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.error(colors.dim(`\n${entries.length} log entr${entries.length === 1 ? 'y' : 'ies'}\n`));
  printTable(entries);
}

/**
 * Live tail. The server returns newest-first; we re-issue the same query on an
 * interval, dedupe by the synthesized row `id`, and print only unseen rows in
 * chronological order (oldest → newest, `tail -f` style). The id encodes the
 * row's identifying tuple, so it is a stable dedupe key across overlapping
 * polls. `--timeout` caps the run (exit 124); Ctrl-C is the usual stop.
 */
async function followLogs(
  client: ApiClient,
  opts: LogsSearchOptions,
  body: LogsSearchBody,
): Promise<void> {
  const intervalMs = Math.max(1000, (opts.interval ?? 4) * 1000);
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : undefined;
  const pageSize = opts.limit ?? 200;
  const started = Date.now();
  const seen = new Set<string>();
  const tty = isStdoutTTY();
  let channelWidth = 9;

  // Seed the window from now so we don't replay the backlog; the first poll
  // surfaces only rows that arrive after the tail starts (matching `tail -f`).
  let highWater = body.from ?? new Date().toISOString();
  console.error(colors.dim(`tailing logs (poll ${intervalMs / 1000}s, Ctrl-C to stop)…\n`));

  while (true) {
    const page = await search(client, { ...body, from: highWater, limit: pageSize });
    // Server order is newest-first; reverse to print oldest-first.
    const fresh = page.entries.filter((e) => !seen.has(e.id)).reverse();
    for (const e of fresh) {
      seen.add(e.id);
      channelWidth = Math.min(24, Math.max(channelWidth, (e.channel ?? '').length));
      if (opts.json) {
        console.log(JSON.stringify(e));
      } else {
        console.log(formatRow(e, channelWidth));
      }
      if (e.timestamp > highWater) highWater = e.timestamp;
    }
    // Bound the dedupe set so a long-running tail doesn't grow unboundedly; the
    // high-water mark already filters most replays, the set just catches ties.
    if (seen.size > 10_000) {
      seen.clear();
      for (const e of page.entries) seen.add(e.id);
    }
    if (timeoutMs !== undefined && Date.now() - started > timeoutMs) {
      if (!tty) console.error(colors.dim('tail timeout reached'));
      throw new TimeoutError(`Tail did not stop within ${opts.timeout}s.`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface LogsFacetsOptions extends LogsSearchOptions {}

function printFacetGroup(label: string, counts: LogFacetCount[]): void {
  if (counts.length === 0) return;
  console.log(colors.bold(label));
  for (const c of counts) {
    console.log(`  ${c.value.padEnd(28)} ${colors.dim(String(c.count))}`);
  }
  console.log('');
}

/**
 * Facet discovery: run the same query but report only the aggregated counts.
 * Lets an agent learn the filter space (which sources / channels / providers /
 * tags actually have logs in the window) before issuing a narrowed search.
 */
export async function runLogsFacets(opts: LogsFacetsOptions): Promise<void> {
  const { client } = await openSession(opts, 'logs facets');
  // Facets ignore limit, but the schema requires a sane value; keep it small.
  const body = buildSearchBody({ ...opts, limit: 1 });
  const page = await search(client, body);

  if (opts.json) {
    console.log(JSON.stringify(page.facets, null, 2));
    return;
  }
  console.error('');
  printFacetGroup('SOURCE', page.facets.source);
  printFacetGroup('LEVEL', page.facets.level);
  printFacetGroup('CHANNEL', page.facets.channel);
  printFacetGroup('PROVIDER', page.facets.provider);
  printFacetGroup('ORIGIN', page.facets.origin);
  printFacetGroup('TAGS', page.facets.tags);
}
