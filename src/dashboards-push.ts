/**
 * `quickflo dashboards push` — upsert dashboards from local native JSON files
 * (the shape `dashboards pull` writes) back into the same org.
 *
 * Reconciliation per file:
 *   - Dashboard: if `id` exists in the org → PATCH metadata; else → create.
 *   - Widgets: keyed by `id`. A UUID that matches an existing widget → PATCH;
 *     anything else (missing id, or a non-UUID placeholder like
 *     "conversion-card") → create. Existing widgets absent from the file are
 *     deleted. New widget ids are mapped placeholder → real so the layout can
 *     reference them.
 *   - Layout: widgetIds are remapped through that map, then saved.
 *
 * Data sources are referenced by id and must already exist in the target org
 * (same-org round-trip). Widgets pointing at an unknown `dataSourceId` are a
 * hard error with a pointer to `dashboards sources create` or `dashboards
 * import` (the portable, source-remapping path). `--create-missing-sources`
 * opts into recreating embedded `dataSources` whose id is absent.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import {
  type Dashboard,
  type DashboardDataSource,
  type DashboardWidget,
  type DashboardWithWidgets,
  fetchDashboardList,
  fetchDataSources,
} from './dashboards-refs.ts';
import { UserError } from './errors.ts';
import { info, warn } from './log.ts';
import { UUID_RE } from './refs.ts';
import { openSession } from './session.ts';

interface DashboardFile {
  id?: string;
  name: string;
  description?: string | null;
  timezone?: string | null;
  isDefault?: boolean;
  filterConfig?: unknown[] | null;
  filterDefaults?: Record<string, string[]> | null;
  layout?: Array<Record<string, unknown>>;
  widgets?: Array<Record<string, unknown>>;
  dataSources?: Array<Record<string, unknown>>;
}

async function readDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith('.json')) {
        files.push(`${dir}/${entry.name}`);
      }
    }
  } catch (err) {
    throw new UserError(`Cannot read directory ${dir}: ${(err as Error).message}`);
  }
  return files.sort();
}

export function widgetPayload(w: Record<string, unknown>): Record<string, unknown> {
  return {
    title: w['title'],
    chartType: w['chartType'],
    dataSourceId: w['dataSourceId'],
    queryConfig: w['queryConfig'] ?? {},
    ...(w['displayConfig'] !== undefined ? { displayConfig: w['displayConfig'] } : {}),
  };
}

/** Every data-source id a file's widgets/filters reference. */
function referencedSourceIds(file: DashboardFile): Set<string> {
  const ids = new Set<string>();
  for (const w of file.widgets ?? []) {
    const dsId = w['dataSourceId'];
    if (typeof dsId === 'string') ids.add(dsId);
    const joins = (w['queryConfig'] as Record<string, unknown> | undefined)?.['joins'] as
      | Array<{ source?: string }>
      | undefined;
    for (const j of joins ?? []) {
      if (j.source) ids.add(j.source);
    }
  }
  for (const fc of (file.filterConfig ?? []) as Array<Record<string, unknown>>) {
    if (typeof fc['dataSourceId'] === 'string') ids.add(fc['dataSourceId'] as string);
    const bindings = fc['bindings'] as Array<{ dataSourceId?: string }> | undefined;
    for (const b of bindings ?? []) {
      if (b.dataSourceId) ids.add(b.dataSourceId);
    }
  }
  return ids;
}

async function ensureSources(
  client: ApiClient,
  file: DashboardFile,
  existingIds: Set<string>,
  createMissing: boolean,
  label: string,
): Promise<void> {
  const wanted = referencedSourceIds(file);
  const missing = [...wanted].filter((id) => !existingIds.has(id));
  if (missing.length === 0) return;

  if (!createMissing) {
    throw new UserError(
      `${label}: references ${missing.length} data source(s) not in this org:\n` +
        missing.map((id) => `  ${id}`).join('\n') +
        `\nCreate them first (dashboards sources create) or use ` +
        `dashboards import for cross-org remapping. ` +
        `--create-missing-sources recreates embedded source definitions as-is.`,
    );
  }

  const embedded = new Map(
    (file.dataSources ?? [])
      .filter((d) => typeof d['id'] === 'string')
      .map((d) => [d['id'] as string, d]),
  );
  for (const id of missing) {
    const def = embedded.get(id);
    if (!def) {
      throw new UserError(
        `${label}: missing data source ${id} has no embedded definition under "dataSources" to recreate.`,
      );
    }
    // Recreate with the same id so widget refs stay valid.
    const created = await apiFetch<DashboardDataSource>(
      client,
      '/dashboards/data-sources',
      { method: 'POST', body: JSON.stringify(def) },
    );
    existingIds.add(created.id);
    // If the server assigned a fresh id, the embedded one no longer matches —
    // surface it rather than silently breaking widget references.
    if (created.id !== id) {
      throw new UserError(
        `${label}: recreated data source got a new id (${created.id} != ${id}); ` +
          `native push cannot remap source ids. Use dashboards import instead.`,
      );
    }
    info(`    ${colors.green('+')} created data source ${colors.bold(String(def['name'] ?? id))}`);
  }
}

async function reconcileWidgets(
  client: ApiClient,
  dashboardId: string,
  fileWidgets: Array<Record<string, unknown>>,
  currentWidgets: DashboardWidget[],
  dryRun: boolean,
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>(); // file widgetId → real widgetId
  const currentById = new Map(currentWidgets.map((w) => [w.id, w]));
  const keptIds = new Set<string>();

  for (const w of fileWidgets) {
    const fileId = typeof w['id'] === 'string' ? w['id'] : undefined;
    const isExisting = fileId && UUID_RE.test(fileId) && currentById.has(fileId);

    if (isExisting && fileId) {
      keptIds.add(fileId);
      idMap.set(fileId, fileId);
      if (dryRun) {
        info(`    ${colors.dim('~')} widget ${colors.bold(String(w['title']))} (update)`);
        continue;
      }
      await apiFetch<DashboardWidget>(client, `/dashboards/widgets/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify(widgetPayload(w)),
      });
      info(`    ${colors.dim('~')} widget ${colors.bold(String(w['title']))} (updated)`);
    } else {
      if (dryRun) {
        if (fileId) idMap.set(fileId, `<new:${fileId}>`);
        info(`    ${colors.green('+')} widget ${colors.bold(String(w['title']))} (create)`);
        continue;
      }
      const created = await apiFetch<DashboardWidget>(
        client,
        `/dashboards/${dashboardId}/widgets`,
        { method: 'POST', body: JSON.stringify(widgetPayload(w)) },
      );
      keptIds.add(created.id);
      if (fileId) idMap.set(fileId, created.id);
      info(`    ${colors.green('+')} widget ${colors.bold(String(w['title']))} (created)`);
    }
  }

  // Delete widgets that exist remotely but are no longer in the file.
  for (const w of currentWidgets) {
    if (keptIds.has(w.id)) continue;
    if (dryRun) {
      info(`    ${colors.red('-')} widget ${colors.bold(w.title)} (delete)`);
      continue;
    }
    await apiFetch<{ deleted: boolean }>(client, `/dashboards/widgets/${w.id}`, {
      method: 'DELETE',
    });
    info(`    ${colors.red('-')} widget ${colors.bold(w.title)} (deleted)`);
  }

  return idMap;
}

function remapLayout(
  layout: Array<Record<string, unknown>> | undefined,
  idMap: Map<string, string>,
): Array<Record<string, unknown>> {
  return (layout ?? []).map((item) => {
    const widgetId = item['widgetId'];
    if (typeof widgetId === 'string' && idMap.has(widgetId)) {
      return { ...item, widgetId: idMap.get(widgetId) };
    }
    return { ...item };
  });
}

async function pushOne(
  client: ApiClient,
  file: DashboardFile,
  existingByName: Map<string, Dashboard>,
  existingSourceIds: Set<string>,
  opts: { dryRun: boolean; createMissingSources: boolean },
  label: string,
): Promise<void> {
  await ensureSources(
    client,
    file,
    existingSourceIds,
    opts.createMissingSources,
    label,
  );

  // Resolve the target dashboard: by id if present + found, else by name.
  let target: DashboardWithWidgets | null = null;
  if (file.id && UUID_RE.test(file.id)) {
    try {
      target = await apiFetch<DashboardWithWidgets>(client, `/dashboards/${file.id}`);
    } catch {
      target = null;
    }
  }
  if (!target) {
    const byName = existingByName.get(file.name);
    if (byName) {
      target = await apiFetch<DashboardWithWidgets>(client, `/dashboards/${byName.id}`);
    }
  }

  const metaBody: Record<string, unknown> = {
    name: file.name,
    description: file.description ?? null,
    timezone: file.timezone ?? null,
    filterConfig: file.filterConfig ?? null,
    filterDefaults: file.filterDefaults ?? null,
  };
  if (file.isDefault !== undefined) metaBody['isDefault'] = file.isDefault;

  if (!target) {
    // CREATE
    info(`  ${colors.green('+')} ${label} ${colors.dim('(new dashboard)')}`);
    if (opts.dryRun) {
      await reconcileWidgets(client, '<new>', file.widgets ?? [], [], true);
      return;
    }
    const created = await apiFetch<Dashboard>(client, '/dashboards', {
      method: 'POST',
      body: JSON.stringify({
        name: file.name,
        description: file.description ?? undefined,
        timezone: file.timezone ?? undefined,
        ...(file.isDefault !== undefined ? { isDefault: file.isDefault } : {}),
      }),
    });
    // Create takes only name/desc/timezone/isDefault; PATCH the rest.
    await apiFetch<Dashboard>(client, `/dashboards/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        filterConfig: file.filterConfig ?? null,
        filterDefaults: file.filterDefaults ?? null,
      }),
    });
    const idMap = await reconcileWidgets(
      client,
      created.id,
      file.widgets ?? [],
      [],
      false,
    );
    await apiFetch<Dashboard>(client, `/dashboards/${created.id}/layout`, {
      method: 'PATCH',
      body: JSON.stringify({ layout: remapLayout(file.layout, idMap) }),
    });
    info(
      `  ${colors.green('✓')} created ${colors.bold(file.name)} ${colors.dim(`(${created.id})`)}`,
    );
    return;
  }

  // UPDATE
  info(`  ${colors.dim('~')} ${label} ${colors.dim(`(${target.id})`)}`);
  if (opts.dryRun) {
    await reconcileWidgets(client, target.id, file.widgets ?? [], target.widgets ?? [], true);
    return;
  }
  await apiFetch<Dashboard>(client, `/dashboards/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify(metaBody),
  });
  const idMap = await reconcileWidgets(
    client,
    target.id,
    file.widgets ?? [],
    target.widgets ?? [],
    false,
  );
  await apiFetch<Dashboard>(client, `/dashboards/${target.id}/layout`, {
    method: 'PATCH',
    body: JSON.stringify({ layout: remapLayout(file.layout, idMap) }),
  });
  info(`  ${colors.green('✓')} updated ${colors.bold(file.name)} ${colors.dim(`(${target.id})`)}`);
}

export interface DashboardsPushOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  dryRun?: boolean;
  createMissingSources?: boolean;
}

export async function runDashboardsPush(
  opts: DashboardsPushOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'dashboards push');
  const files = await readDir(opts.dir);
  if (files.length === 0) {
    warn(colors.dim(`No .json files in ${opts.dir}.`));
    return;
  }

  const existingList = await fetchDashboardList(client);
  const existingByName = new Map(existingList.map((d) => [d.name, d]));
  const existingSourceIds = new Set(
    (await fetchDataSources(client)).map((d) => d.id),
  );

  info(colors.dim(`\n${org.name} — pushing ${files.length} file(s) from ${opts.dir}\n`));

  let ok = 0;
  let failed = 0;
  for (const path of files) {
    const label = path.split('/').pop() ?? path;
    let file: DashboardFile;
    try {
      file = JSON.parse(await Deno.readTextFile(path)) as DashboardFile;
    } catch (err) {
      failed++;
      warn(`  ${colors.red('✗')} ${label}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    if (!file.name) {
      failed++;
      warn(`  ${colors.red('✗')} ${label}: missing "name".`);
      continue;
    }
    try {
      await pushOne(client, file, existingByName, existingSourceIds, {
        dryRun: opts.dryRun ?? false,
        createMissingSources: opts.createMissingSources ?? false,
      }, label);
      ok++;
    } catch (err) {
      failed++;
      warn(`  ${colors.red('✗')} ${label}: ${(err as Error).message}`);
    }
  }

  info(colors.dim(`\n${ok} ok, ${failed} failed.`));
}
