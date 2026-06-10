/**
 * Per-record verbs for the data store:
 *   - `list <table>`             → GET /tables/:name (prefix, filter, sort, paginate)
 *   - `get <table> <key>`        → GET /tables/:name/:key
 *   - `set <table> <key> <value>` → PATCH-then-POST-on-404 (upsert)
 *   - `delete <table> <key>`     → DELETE /tables/:name/:key
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { openSession } from './session.ts';

export interface DataStoreEntry {
  id?: string;
  tableName?: string;
  key: string;
  value: unknown;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string | null;
}

interface EntriesListResult {
  entries: DataStoreEntry[];
  total: number;
  hasMore?: boolean;
}

async function fetchEntries(
  client: ApiClient,
  tableName: string,
  opts: {
    prefix?: string;
    filter?: string[];
    sortBy?: string;
    sortDirection?: 'asc' | 'desc';
    limit?: number;
    all?: boolean;
  },
): Promise<DataStoreEntry[]> {
  const pageSize = opts.limit && !opts.all ? opts.limit : 100;
  let offset = 0;
  const all: DataStoreEntry[] = [];
  while (true) {
    const params = new URLSearchParams();
    if (opts.prefix) params.set('prefix', opts.prefix);
    // The server's filter param is a single string; repeated --filter flags
    // are joined into a comma-separated value (the server splits on `,`).
    if (opts.filter && opts.filter.length) {
      params.set('filter', opts.filter.join(','));
    }
    if (opts.sortBy) params.set('sortBy', opts.sortBy);
    if (opts.sortDirection) params.set('sortDirection', opts.sortDirection);
    params.set('limit', String(pageSize));
    params.set('offset', String(offset));
    const res = await apiFetch<EntriesListResult>(
      client,
      `/data-stores/tables/${encodeURIComponent(tableName)}?${params.toString()}`,
    );
    const page = res.entries ?? [];
    all.push(...page);
    if (!opts.all) break;
    if (!(res.hasMore ?? page.length === pageSize)) break;
    offset += pageSize;
  }
  return opts.limit && !opts.all ? all.slice(0, opts.limit) : all;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function printEntriesTable(entries: DataStoreEntry[]): void {
  if (entries.length === 0) {
    console.log(colors.dim('(no entries)'));
    return;
  }
  const keyWidth = Math.min(
    40,
    Math.max(3, ...entries.map((e) => e.key.length)),
  );
  const header = [
    'KEY'.padEnd(keyWidth),
    'VALUE',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const e of entries) {
    const value = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
    console.log([
      truncate(e.key, keyWidth).padEnd(keyWidth),
      truncate(value, 80),
    ].join('  '));
  }
}

export interface DataStoresRecordsListOptions {
  tableName: string;
  prefix?: string;
  filter?: string[];
  sort?: string;
  desc?: boolean;
  limit?: number;
  all?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runDataStoresRecordsList(
  opts: DataStoresRecordsListOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores list');
  const entries = await fetchEntries(client, opts.tableName, {
    prefix: opts.prefix,
    filter: opts.filter,
    sortBy: opts.sort,
    sortDirection: opts.desc ? 'desc' : (opts.sort ? 'asc' : undefined),
    limit: opts.limit,
    all: opts.all,
  });
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.error(
    colors.dim(`\n${opts.tableName} — ${entries.length} entrie(s)\n`),
  );
  printEntriesTable(entries);
}

export interface DataStoresRecordsGetOptions {
  tableName: string;
  key: string;
  apiUrl?: string;
  orgId?: string;
  meta?: boolean;
  json?: boolean;
}

export async function runDataStoresRecordsGet(
  opts: DataStoresRecordsGetOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores get');
  const entry = await apiFetch<DataStoreEntry>(
    client,
    `/data-stores/tables/${encodeURIComponent(opts.tableName)}/${encodeURIComponent(opts.key)}`,
  );
  // --meta emits the full record; otherwise just the value. -j/--json switches
  // from pretty to compact (single-line) so the output drops straight into a
  // pipe; it also suppresses the session banner (handled globally at the root).
  const payload = opts.meta ? entry : entry.value;
  console.log(JSON.stringify(payload, null, opts.json ? undefined : 2));
}

async function readValueArg(
  inline: string | undefined,
  fromStdin: boolean | undefined,
  fromFile: string | undefined,
): Promise<unknown> {
  if (fromStdin) {
    const buf = await new Response(Deno.stdin.readable).text();
    try {
      return JSON.parse(buf);
    } catch {
      return buf;
    }
  }
  if (fromFile) {
    const raw = await Deno.readTextFile(fromFile);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (inline === undefined) {
    throw new Error('Pass a value as the third argument, --from-stdin, or --from-file');
  }
  try {
    return JSON.parse(inline);
  } catch {
    return inline;
  }
}

export interface DataStoresRecordsSetOptions {
  tableName: string;
  key: string;
  value?: string;
  fromStdin?: boolean;
  fromFile?: string;
  ttl?: number;
  apiUrl?: string;
  orgId?: string;
}

export async function runDataStoresRecordsSet(
  opts: DataStoresRecordsSetOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores set');
  const value = await readValueArg(opts.value, opts.fromStdin, opts.fromFile);

  const patchBody: Record<string, unknown> = { value };
  if (opts.ttl !== undefined) patchBody['ttlSeconds'] = opts.ttl;

  // PATCH-then-POST-on-404 — server requires the entry to exist for PATCH.
  try {
    const updated = await apiFetch<DataStoreEntry>(
      client,
      `/data-stores/tables/${encodeURIComponent(opts.tableName)}/${encodeURIComponent(opts.key)}`,
      { method: 'PATCH', body: JSON.stringify(patchBody) },
    );
    console.error(`${colors.green('✓')} updated ${opts.tableName}/${opts.key}`);
    console.log(JSON.stringify(updated.value, null, 2));
    return;
  } catch (e) {
    if (!/404/.test((e as Error).message)) throw e;
  }

  const postBody: Record<string, unknown> = { key: opts.key, value };
  if (opts.ttl !== undefined) postBody['ttlSeconds'] = opts.ttl;
  const created = await apiFetch<DataStoreEntry>(
    client,
    `/data-stores/tables/${encodeURIComponent(opts.tableName)}`,
    { method: 'POST', body: JSON.stringify(postBody) },
  );
  console.error(`${colors.green('✓')} created ${opts.tableName}/${opts.key}`);
  console.log(JSON.stringify(created.value, null, 2));
}

export interface DataStoresRecordsDeleteOptions {
  tableName: string;
  key: string;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runDataStoresRecordsDelete(
  opts: DataStoresRecordsDeleteOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores delete');
  if (
    !await confirmDestructive(
      `Delete entry ${opts.tableName}/${opts.key}?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }
  const res = await apiFetch<{ deleted: boolean }>(
    client,
    `/data-stores/tables/${encodeURIComponent(opts.tableName)}/${encodeURIComponent(opts.key)}`,
    { method: 'DELETE' },
  );
  console.error(
    res.deleted
      ? `${colors.green('✓')} deleted ${opts.tableName}/${opts.key}`
      : `${colors.yellow('!')} ${opts.tableName}/${opts.key} did not exist`,
  );
}
