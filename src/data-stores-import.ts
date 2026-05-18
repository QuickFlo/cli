/**
 * `quickflo data-stores import <table> -f <file>` — bulk-upsert entries from a
 * JSON file. Accepts either an array of `{key, value}` or an object map
 * `{key: value}`. Batched in chunks of 500.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';

interface BulkImportResult {
  created: number;
  updated: number;
  failed?: Array<{ key: string; error: string }>;
}

const BATCH_SIZE = 500;

function normalizeEntries(input: unknown): Array<{ key: string; value: unknown }> {
  if (Array.isArray(input)) {
    return input.map((e, i) => {
      if (!e || typeof e !== 'object' || !('key' in e)) {
        throw new Error(`Item ${i}: missing 'key'`);
      }
      const row = e as { key: unknown; value: unknown };
      if (typeof row.key !== 'string') {
        throw new Error(`Item ${i}: 'key' must be a string`);
      }
      return { key: row.key, value: row.value };
    });
  }
  if (input && typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>).map(([key, value]) => ({
      key,
      value,
    }));
  }
  throw new Error('Input must be an array of {key, value} or an object map.');
}

async function importBatch(
  client: ApiClient,
  tableName: string,
  entries: Array<{ key: string; value: unknown }>,
): Promise<BulkImportResult> {
  return await apiFetch<BulkImportResult>(
    client,
    `/data-stores/tables/${encodeURIComponent(tableName)}/import`,
    { method: 'POST', body: JSON.stringify({ entries }) },
  );
}

export interface DataStoresImportOptions {
  tableName: string;
  file?: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runDataStoresImport(
  opts: DataStoresImportOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores import');

  const raw = opts.file
    ? await Deno.readTextFile(opts.file)
    : await new Response(Deno.stdin.readable).text();
  const parsed = JSON.parse(raw) as unknown;
  const entries = normalizeEntries(parsed);
  console.error(
    `\nImporting ${colors.bold(String(entries.length))} entrie(s) into ${opts.tableName}`,
  );

  let created = 0;
  let updated = 0;
  const failures: Array<{ key: string; error: string }> = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(entries.length / BATCH_SIZE);
    try {
      const r = await importBatch(client, opts.tableName, batch);
      created += r.created ?? 0;
      updated += r.updated ?? 0;
      if (r.failed) failures.push(...r.failed);
      console.error(
        `  ${colors.green('✓')} batch ${batchNum}/${total} (${batch.length} entries)`,
      );
    } catch (e) {
      console.error(
        `  ${colors.red('✗')} batch ${batchNum}/${total}: ${(e as Error).message}`,
      );
      for (const b of batch) failures.push({ key: b.key, error: (e as Error).message });
    }
  }

  console.error('\n' + colors.bold('Summary'));
  console.error(
    `  ${colors.green(`${created} created`)}, ${colors.yellow(`${updated} updated`)}, ${
      failures.length > 0 ? colors.red(`${failures.length} failed`) : `${failures.length} failed`
    }`,
  );
  if (failures.length > 0) Deno.exit(1);
}
