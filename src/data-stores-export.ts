/**
 * `quickflo data-stores export <table>` — paginate through every entry in a
 * table and emit a JSON array of `{key, value}` to stdout (or `-o <file>`).
 * Pipe-friendly: pairs with `data-stores import` for round-trip.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { type DataStoreEntry } from './data-stores-records.ts';
import { openSession } from './session.ts';

interface EntriesListResult {
  entries: DataStoreEntry[];
  total: number;
  hasMore?: boolean;
}

/**
 * Paginate through a table's entries. `limit` caps how many are fetched
 * (default: unlimited) — callers like `backup` pass a cap so a giant table
 * can't blow up a snapshot, and detect truncation by checking whether the
 * returned count equals the cap.
 */
export async function fetchAllEntries(
  client: ApiClient,
  tableName: string,
  limit = Infinity,
): Promise<DataStoreEntry[]> {
  const pageSize = Math.min(500, limit);
  let offset = 0;
  const all: DataStoreEntry[] = [];
  while (all.length < limit) {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(pageSize, limit - all.length)));
    params.set('offset', String(offset));
    params.set('sortBy', 'key');
    params.set('sortDirection', 'asc');
    const res = await apiFetch<EntriesListResult>(
      client,
      `/data-stores/tables/${encodeURIComponent(tableName)}?${params.toString()}`,
    );
    const page = res.entries ?? [];
    all.push(...page);
    if (!(res.hasMore ?? page.length === pageSize)) break;
    offset += pageSize;
  }
  return all.length > limit ? all.slice(0, limit) : all;
}

export interface DataStoresExportOptions {
  tableName: string;
  output?: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runDataStoresExport(
  opts: DataStoresExportOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores export');
  const entries = await fetchAllEntries(client, opts.tableName);
  const rows = entries.map((e) => ({ key: e.key, value: e.value }));
  const payload = JSON.stringify(rows, null, 2) + '\n';
  if (opts.output) {
    await Deno.writeTextFile(opts.output, payload);
    console.error(
      `${colors.green('✓')} exported ${rows.length} entrie(s) → ${opts.output}`,
    );
  } else {
    console.log(payload);
  }
}
