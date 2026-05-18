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
  data: DataStoreEntry[];
  total: number;
}

async function fetchAllEntries(
  client: ApiClient,
  tableName: string,
): Promise<DataStoreEntry[]> {
  const pageSize = 500;
  let offset = 0;
  const all: DataStoreEntry[] = [];
  while (true) {
    const params = new URLSearchParams();
    params.set('limit', String(pageSize));
    params.set('offset', String(offset));
    params.set('sortBy', 'key');
    params.set('sortDirection', 'asc');
    const res = await apiFetch<EntriesListResult>(
      client,
      `/data-stores/tables/${encodeURIComponent(tableName)}?${params.toString()}`,
    );
    const page = res.data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
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
