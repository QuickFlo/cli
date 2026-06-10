/**
 * `quickflo data-stores export <table>` — paginate through a table's entries
 * and emit them to stdout (or `--out <file>`) as a JSON array (default),
 * NDJSON, or CSV. The same query flags as `list` (`--prefix`, `--filter`,
 * `--sort`/`--desc`, `--limit`) narrow what gets exported. Pipe-friendly:
 * the JSON/NDJSON shapes pair with `data-stores import` for round-trip.
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

export interface FetchAllEntriesOptions {
  prefix?: string;
  filter?: string[];
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  /** Cap how many entries are fetched (default: unlimited). */
  limit?: number;
}

/**
 * Paginate through a table's entries. `limit` caps how many are fetched
 * (default: unlimited) — callers like `backup` pass a cap so a giant table
 * can't blow up a snapshot, and detect truncation by checking whether the
 * returned count equals the cap. For backward compatibility the third arg may
 * be a bare number (treated as `{ limit }`).
 */
export async function fetchAllEntries(
  client: ApiClient,
  tableName: string,
  optsOrLimit: number | FetchAllEntriesOptions = {},
): Promise<DataStoreEntry[]> {
  const opts: FetchAllEntriesOptions = typeof optsOrLimit === 'number'
    ? { limit: optsOrLimit }
    : optsOrLimit;
  const limit = opts.limit ?? Infinity;
  const pageSize = Math.min(500, limit);
  let offset = 0;
  const all: DataStoreEntry[] = [];
  while (all.length < limit) {
    const params = new URLSearchParams();
    if (opts.prefix) params.set('prefix', opts.prefix);
    if (opts.filter && opts.filter.length) {
      params.set('filter', opts.filter.join(','));
    }
    params.set('sortBy', opts.sortBy ?? 'key');
    params.set('sortDirection', opts.sortDirection ?? 'asc');
    params.set('limit', String(Math.min(pageSize, limit - all.length)));
    params.set('offset', String(offset));
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

export type ExportFormat = 'json' | 'ndjson' | 'csv';

/** RFC-4180 cell: wrap in quotes and double any embedded quotes. */
function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

function serialize(
  rows: Array<{ key: string; value: unknown }>,
  format: ExportFormat,
): string {
  switch (format) {
    case 'ndjson':
      // One {key,value} object per line — streaming/grep-friendly.
      return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    case 'csv': {
      // Two columns: key, value. The value column is JSON so nested objects
      // survive a round-trip rather than being flattened lossily.
      const lines = ['key,value'];
      for (const r of rows) {
        const value = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
        lines.push(`${csvCell(r.key)},${csvCell(value)}`);
      }
      return lines.join('\n') + '\n';
    }
    case 'json':
    default:
      return JSON.stringify(rows, null, 2) + '\n';
  }
}

export interface DataStoresExportOptions {
  tableName: string;
  output?: string;
  format?: ExportFormat;
  prefix?: string;
  filter?: string[];
  sort?: string;
  desc?: boolean;
  limit?: number;
  apiUrl?: string;
  orgId?: string;
}

export async function runDataStoresExport(
  opts: DataStoresExportOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores export');
  const format = opts.format ?? 'json';
  const entries = await fetchAllEntries(client, opts.tableName, {
    prefix: opts.prefix,
    filter: opts.filter,
    sortBy: opts.sort,
    sortDirection: opts.desc ? 'desc' : (opts.sort ? 'asc' : undefined),
    limit: opts.limit,
  });
  const rows = entries.map((e) => ({ key: e.key, value: e.value }));
  const payload = serialize(rows, format);
  if (opts.output) {
    await Deno.writeTextFile(opts.output, payload);
    console.error(
      `${colors.green('✓')} exported ${rows.length} entrie(s) (${format}) → ${opts.output}`,
    );
  } else {
    // Write without an extra trailing newline beyond what serialize() added.
    await Deno.stdout.write(new TextEncoder().encode(payload));
  }
}
