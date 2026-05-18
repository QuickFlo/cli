/**
 * `quickflo workflows executions list` — query execution traces. Default
 * order `startedAt:DESC`, default limit 25. Convenience flags `--workflow`,
 * `--status`, `--since <duration>` layer on top of the standard `--where`
 * grammar. Table to stdout, banner / counts to stderr.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { openSession } from './session.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { UserError } from './errors.ts';
import { type Lookup } from './refs.ts';

interface TraceRow {
  id: string;
  workflowId?: string;
  workflowName?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  durationMilliseconds?: number;
}

interface TracesResponse {
  data: TraceRow[];
  meta?: { total?: number };
}

const DURATION_RE = /^(\d+)\s*(s|m|h|d)$/i;

function parseDuration(s: string): number {
  const m = DURATION_RE.exec(s.trim());
  if (!m) throw new UserError(`Invalid --since "${s}". Expected forms: 30s, 5m, 2h, 1d.`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

function colorStatus(s: string): string {
  if (s === 'success') return colors.green(s);
  if (s === 'failed' || s === 'error') return colors.red(s);
  if (s === 'cancelled') return colors.yellow(s);
  if (s === 'running') return colors.cyan(s);
  return s;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function formatTs(iso?: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—';
}

function printTable(rows: TraceRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no executions)'));
    return;
  }
  const nameWidth = Math.min(
    32,
    Math.max(8, ...rows.map((r) => (r.workflowName ?? '').length)),
  );
  const idShort = (id: string) => id.slice(0, 8);
  const header = [
    'ID'.padEnd(8),
    'WORKFLOW'.padEnd(nameWidth),
    'STATUS'.padEnd(10),
    'STARTED'.padEnd(19),
    'DURATION',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    console.log([
      idShort(r.id).padEnd(8),
      truncate(r.workflowName ?? '—', nameWidth).padEnd(nameWidth),
      colorStatus(r.status ?? '—').padEnd(20), // ANSI-aware budget
      formatTs(r.startedAt).padEnd(19),
      r.durationMilliseconds !== undefined ? `${r.durationMilliseconds}ms` : '—',
    ].join('  '));
  }
}

async function fetchPage(
  client: ApiClient,
  params: URLSearchParams,
  offset: number,
  limit: number,
): Promise<TracesResponse> {
  params.set('options[offset]', String(offset));
  params.set('options[limit]', String(limit));
  return await apiFetch<TracesResponse>(client, `/execution-traces?${params.toString()}`);
}

export interface WorkflowsExecutionsListOptions extends ListOptions {
  workflow?: string;
  by?: Lookup;
  status?: string;
  since?: string;
  all?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsExecutionsList(
  opts: WorkflowsExecutionsListOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'workflows executions list');
  const order = opts.order ?? 'startedAt:DESC';
  const baseParams = buildListParams({ ...opts, order, limit: undefined });

  if (opts.workflow) {
    const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
    baseParams.set('where[workflowId][$eq]', wf.id);
  }
  if (opts.status) {
    baseParams.set('where[status][$eq]', opts.status);
  }
  if (opts.since) {
    const cutoff = new Date(Date.now() - parseDuration(opts.since)).toISOString();
    baseParams.set('where[startedAt][$gte]', cutoff);
  }

  const pageSize = opts.limit ?? 25;
  const all = opts.all ?? false;
  const rows: TraceRow[] = [];
  let offset = 0;
  while (true) {
    const res = await fetchPage(client, new URLSearchParams(baseParams), offset, pageSize);
    rows.push(...(res.data ?? []));
    if (!all || (res.data?.length ?? 0) < pageSize) break;
    offset += pageSize;
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error(colors.dim(`\n${rows.length} execution(s)\n`));
  printTable(rows);
}
