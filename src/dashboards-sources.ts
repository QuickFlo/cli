/**
 * `quickflo dashboards sources ...` — manage and introspect dashboard data
 * sources, the records that map a data-store table into queryable
 * dimensions/measures. This is the load-bearing surface for an agent
 * authoring dashboards: widgets reference a `dataSourceId` plus field names,
 * so the agent needs to create sources, read their schema, and refresh it.
 *
 *   list                       all data sources in the org
 *   get <ref>                  one source (UUID or name), full record
 *   create -f file.json        create from a JSON body (createDataSource shape)
 *   update <ref> -f file.json  patch a source from a JSON body
 *   delete <ref>               remove a source
 *   refresh <ref>              re-sample the underlying table's schema
 *   sync <ref>                 trigger the source's sync workflow
 *   distinct <ref> <dim>       distinct values for a dimension (filter options)
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import {
  type DashboardDataSource,
  fetchDataSources,
  resolveDataSourceRef,
} from './dashboards-refs.ts';
import { UserError } from './errors.ts';
import { openSession } from './session.ts';

interface CommonOptions {
  apiUrl?: string;
  orgId?: string;
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    throw new UserError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new UserError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

// ── list ────────────────────────────────────────────────────────────────

export interface SourcesListOptions extends CommonOptions {
  json?: boolean;
  includePackages?: boolean;
}

function fieldSummary(ds: DashboardDataSource): { dims: number; measures: number } {
  const fields = ds.recordSchema?.fields ?? {};
  let dims = 0;
  let measures = 0;
  for (const f of Object.values(fields)) {
    if (f.measure) measures++;
    else dims++;
  }
  for (const cf of ds.recordSchema?.calculatedFields ?? []) {
    if (cf.measure) measures++;
    else dims++;
  }
  return { dims, measures };
}

export async function runSourcesList(opts: SourcesListOptions): Promise<void> {
  const { client, org } = await openSession(opts, 'dashboards sources list');
  let rows = await fetchDataSources(client);
  if (!opts.includePackages) {
    rows = rows.filter((d) => !d.packageInstallId);
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.error(colors.dim(`\n${org.name} — ${rows.length} data source(s)\n`));
  if (rows.length === 0) {
    console.log(colors.dim('(no data sources)'));
    return;
  }
  const nameWidth = Math.min(32, Math.max(4, ...rows.map((r) => r.name.length)));
  const tableWidth = Math.min(
    28,
    Math.max(5, ...rows.map((r) => r.dataStoreTableName.length)),
  );
  const header = [
    'NAME'.padEnd(nameWidth),
    'TABLE'.padEnd(tableWidth),
    'DIM'.padStart(4),
    'MEAS'.padStart(4),
    'ENGINE'.padEnd(10),
    'UUID',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const { dims, measures } = fieldSummary(r);
    console.log([
      r.name.slice(0, nameWidth).padEnd(nameWidth),
      r.dataStoreTableName.slice(0, tableWidth).padEnd(tableWidth),
      String(dims).padStart(4),
      String(measures).padStart(4),
      (r.servingEngine ?? 'postgres').padEnd(10),
      r.id,
    ].join('  '));
  }
}

// ── get ─────────────────────────────────────────────────────────────────

export interface SourcesGetOptions extends CommonOptions {
  ref: string;
}

export async function runSourcesGet(opts: SourcesGetOptions): Promise<void> {
  const { client } = await openSession(opts, 'dashboards sources get');
  const ds = await resolveDataSourceRef(client, opts.ref);
  console.log(JSON.stringify(ds, null, 2));
}

// ── create ──────────────────────────────────────────────────────────────

export interface SourcesCreateOptions extends CommonOptions {
  file: string;
  json?: boolean;
}

export async function runSourcesCreate(
  opts: SourcesCreateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards sources create');
  const body = await readJsonFile(opts.file);
  const created = await apiFetch<DashboardDataSource>(
    client,
    '/dashboards/data-sources',
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (opts.json) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  console.error(
    `${colors.green('✓')} created data source ${colors.bold(created.name)} ${
      colors.dim(`(${created.id})`)
    }`,
  );
}

// ── update ──────────────────────────────────────────────────────────────

export interface SourcesUpdateOptions extends CommonOptions {
  ref: string;
  file: string;
  json?: boolean;
}

export async function runSourcesUpdate(
  opts: SourcesUpdateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards sources update');
  const ds = await resolveDataSourceRef(client, opts.ref);
  const body = await readJsonFile(opts.file);
  // The server accepts recordSchema.{name,fields} only — computed fields ride
  // dedicated routes. Warn instead of letting the strip pass silently.
  const schema = body['recordSchema'] as Record<string, unknown> | undefined;
  for (
    const [key, cmd] of [
      ['calculatedFields', 'calc-field set'],
      ['windowDimensions', 'window-dim set'],
    ] as const
  ) {
    if (schema && schema[key] !== undefined) {
      console.error(
        `${
          colors.yellow('⚠')
        } recordSchema.${key} is IGNORED by this endpoint — the server strips it. ` +
          `Use "quickflo dashboards sources ${cmd} ${opts.ref} -f <field.json>" instead.`,
      );
    }
  }
  const updated = await apiFetch<DashboardDataSource>(
    client,
    `/dashboards/data-sources/${ds.id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (opts.json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.error(
    `${colors.green('✓')} updated data source ${colors.bold(updated.name)} ${
      colors.dim(`(${updated.id})`)
    }`,
  );
}

// ── delete ──────────────────────────────────────────────────────────────

export interface SourcesDeleteOptions extends CommonOptions {
  ref: string;
  yes?: boolean;
}

export async function runSourcesDelete(
  opts: SourcesDeleteOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'dashboards sources delete');
  const ds = await resolveDataSourceRef(client, opts.ref);
  if (
    !await confirmDestructive(
      `Delete data source "${ds.name}" in ${org.name}? Widgets that reference it will break.`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }
  await apiFetch<{ deleted: boolean }>(
    client,
    `/dashboards/data-sources/${ds.id}`,
    { method: 'DELETE' },
  );
  console.error(
    `${colors.green('✓')} deleted data source ${colors.bold(ds.name)} ${colors.dim(`(${ds.id})`)}`,
  );
}

// ── refresh-schema ──────────────────────────────────────────────────────

export interface SourcesRefreshOptions extends CommonOptions {
  ref: string;
}

export async function runSourcesRefresh(
  opts: SourcesRefreshOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards sources refresh');
  const ds = await resolveDataSourceRef(client, opts.ref);
  const res = await apiFetch<{ refreshed: boolean; fieldsChanged?: boolean }>(
    client,
    `/dashboards/data-sources/${ds.id}/refresh-schema`,
    { method: 'POST' },
  );
  console.error(
    `${colors.green('✓')} refreshed schema for ${colors.bold(ds.name)}` +
      (res.fieldsChanged ? colors.yellow(' (fields changed)') : colors.dim(' (no field changes)')),
  );
}

// ── sync ────────────────────────────────────────────────────────────────

export interface SourcesSyncOptions extends CommonOptions {
  ref: string;
  startDate?: string;
  endDate?: string;
  json?: boolean;
}

export async function runSourcesSync(opts: SourcesSyncOptions): Promise<void> {
  const { client } = await openSession(opts, 'dashboards sources sync');
  const ds = await resolveDataSourceRef(client, opts.ref);
  const body: Record<string, unknown> = {};
  if (opts.startDate) body['startDate'] = opts.startDate;
  if (opts.endDate) body['endDate'] = opts.endDate;
  const res = await apiFetch<Record<string, unknown>>(
    client,
    `/dashboards/data-sources/${ds.id}/sync`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.error(`${colors.green('✓')} triggered sync for ${colors.bold(ds.name)}`);
}

// ── distinct ────────────────────────────────────────────────────────────

export interface SourcesDistinctOptions extends CommonOptions {
  ref: string;
  dimension: string;
  search?: string;
  limit?: number;
  json?: boolean;
}

export async function runSourcesDistinct(
  opts: SourcesDistinctOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards sources distinct');
  const ds = await resolveDataSourceRef(client, opts.ref);
  const body: Record<string, unknown> = {
    dataSourceId: ds.id,
    dimension: opts.dimension,
  };
  if (opts.search) body['search'] = opts.search;
  if (opts.limit !== undefined) body['limit'] = opts.limit;
  const res = await apiFetch<{ values: string[] }>(
    client,
    '/dashboards/analytics/distinct-values',
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (opts.json) {
    console.log(JSON.stringify(res.values ?? [], null, 2));
    return;
  }
  for (const v of res.values ?? []) {
    console.log(v);
  }
}
