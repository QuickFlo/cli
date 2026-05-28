/**
 * Data store table catalog: `tables list`, `tables create`, `tables delete`.
 * The data store is a JSONB KV with a `tableName` namespace; tables are
 * created implicitly the first time you `set` a key, or explicitly here to
 * pre-register a namespace.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { openSession } from './session.ts';

interface TablesListResult {
  tables: Array<{ tableName: string; keyCount?: number; analyticsTag?: string }>;
  total: number;
  hasMore?: boolean;
}

export async function fetchTables(
  client: ApiClient,
  opts: { all: boolean; limit?: number },
): Promise<TablesListResult['tables']> {
  const pageSize = opts.limit && !opts.all ? opts.limit : 100;
  let offset = 0;
  const all: TablesListResult['tables'] = [];
  while (true) {
    const params = new URLSearchParams();
    params.set('limit', String(pageSize));
    params.set('offset', String(offset));
    const res = await apiFetch<TablesListResult>(
      client,
      `/data-stores/tables?${params.toString()}`,
    );
    const page = res.tables ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    if (!opts.all) break;
    offset += pageSize;
  }
  return opts.limit && !opts.all ? all.slice(0, opts.limit) : all;
}

export interface DataStoresTablesListOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  all?: boolean;
  limit?: number;
}

export async function runDataStoresTablesList(
  opts: DataStoresTablesListOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'data-stores tables list');
  const tables = await fetchTables(client, {
    all: opts.all ?? false,
    limit: opts.limit,
  });
  if (opts.json) {
    console.log(JSON.stringify(tables, null, 2));
    return;
  }
  console.error(
    colors.dim(`\n${org.name} — ${tables.length} table(s)\n`),
  );
  if (tables.length === 0) {
    console.log(colors.dim('(no tables)'));
    return;
  }
  const nameWidth = Math.min(
    48,
    Math.max(4, ...tables.map((t) => t.tableName.length)),
  );
  const header = ['NAME'.padEnd(nameWidth), 'KEYS'.padStart(6), 'TAG'].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const t of tables) {
    console.log([
      t.tableName.padEnd(nameWidth),
      String(t.keyCount ?? 0).padStart(6),
      t.analyticsTag ?? '-',
    ].join('  '));
  }
}

export interface DataStoresTablesCreateOptions {
  tableName: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runDataStoresTablesCreate(
  opts: DataStoresTablesCreateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'data-stores tables create');
  const res = await apiFetch<{ tableName: string; created: boolean }>(
    client,
    `/data-stores/tables`,
    {
      method: 'POST',
      body: JSON.stringify({ tableName: opts.tableName }),
    },
  );
  if (res.created) {
    console.error(`${colors.green('✓')} created table ${colors.bold(res.tableName)}`);
  } else {
    console.error(
      `${colors.dim('•')} table ${colors.bold(res.tableName)} already exists`,
    );
  }
}

export interface DataStoresTablesDeleteOptions {
  tableName: string;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runDataStoresTablesDelete(
  opts: DataStoresTablesDeleteOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'data-stores tables delete');
  if (
    !await confirmDestructive(
      `Delete table "${opts.tableName}" and ALL its entries in ${org.name}?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }
  const res = await apiFetch<{ deleted: number }>(
    client,
    `/data-stores/tables/${encodeURIComponent(opts.tableName)}`,
    { method: 'DELETE' },
  );
  console.error(
    `${colors.green('✓')} deleted table ${colors.bold(opts.tableName)} (${res.deleted} entries)`,
  );
}
