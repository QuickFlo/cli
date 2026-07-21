/**
 * `quickflo dashboards import` — import a portable dashboard export (from
 * `dashboards export` or the in-app export) into the current org.
 *
 * The export references data sources by export id (`ds-0`, ...). Import has to
 * map each onto a real data source in THIS org. We auto-map by matching the
 * exported source name against the org's sources; `--map <exportId|name>=<ref>`
 * overrides any of them (ref = source UUID or name). If anything is left
 * unmapped we stop and list it rather than importing a half-wired dashboard.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import {
  type CalculatedField,
  type DashboardDataSource,
  type DashboardWithWidgets,
  fetchDataSources,
  type WindowDimension,
} from './dashboards-refs.ts';
import {
  applyComputedFieldSync,
  type ComputedFieldSyncResult,
  describeSyncResults,
  planComputedFieldSync,
} from './dashboards-source-fields.ts';
import { UserError } from './errors.ts';
import { info } from './log.ts';
import { UUID_RE } from './refs.ts';
import { openSession } from './session.ts';

interface ExportedSource {
  exportId: string;
  name: string;
  schema?: {
    name?: string;
    calculatedFields?: CalculatedField[];
    windowDimensions?: WindowDimension[];
  };
}

interface PortableExport {
  version?: number;
  exportedAt?: string;
  dashboard?: { name?: string };
  dataSources?: ExportedSource[];
  widgets?: unknown[];
  [key: string]: unknown;
}

async function readJsonFile(path: string): Promise<PortableExport> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    throw new UserError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as PortableExport;
  } catch (err) {
    throw new UserError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

/** Parse `--map key=value` pairs into a lookup keyed by both exportId and name. */
function parseOverrides(raw: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw ?? []) {
    const eq = entry.indexOf('=');
    if (eq === -1) {
      throw new UserError(`Bad --map "${entry}". Use <exportId|name>=<source-ref>.`);
    }
    out.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return out;
}

function resolveSourceRef(
  ref: string,
  sources: DashboardDataSource[],
): DashboardDataSource | undefined {
  if (UUID_RE.test(ref)) return sources.find((s) => s.id === ref);
  return sources.find((s) => s.name === ref);
}

export interface DashboardsImportOptions {
  file: string;
  apiUrl?: string;
  orgId?: string;
  name?: string;
  map?: string[];
  json?: boolean;
  dryRun?: boolean;
  /**
   * Reconcile computed fields (calculated fields + window dimensions) from the
   * export onto each mapped target source before importing. Widgets reference
   * these by name, so without the reconcile an import onto an existing source
   * silently loses them. Default true; `--no-sync-fields` disables.
   */
  syncFields?: boolean;
}

export async function runDashboardsImport(
  opts: DashboardsImportOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards import');
  const payload = await readJsonFile(opts.file);

  if (!payload.dashboard || !Array.isArray(payload.dataSources)) {
    throw new UserError(
      `${opts.file} is not a dashboard export (missing "dashboard"/"dataSources"). ` +
        `For native files use "dashboards push".`,
    );
  }

  const orgSources = await fetchDataSources(client);
  const overrides = parseOverrides(opts.map);

  const mappings: Record<string, string> = {};
  const unmapped: ExportedSource[] = [];

  for (const ds of payload.dataSources) {
    const override = overrides.get(ds.exportId) ?? overrides.get(ds.name);
    if (override) {
      const match = resolveSourceRef(override, orgSources);
      if (!match) {
        throw new UserError(`--map target "${override}" is not a data source in this org.`);
      }
      mappings[ds.exportId] = match.id;
      info(
        `  ${colors.dim('→')} ${ds.name} ${colors.dim(`(${ds.exportId})`)} → ${match.name} ${
          colors.dim(`(${match.id})`)
        } [override]`,
      );
      continue;
    }
    // Auto-map by exact name, then by schema name.
    const byName = orgSources.find((s) => s.name === ds.name);
    const bySchema = ds.schema?.name
      ? orgSources.find((s) => s.recordSchema?.name === ds.schema?.name)
      : undefined;
    const match = byName ?? bySchema;
    if (match) {
      mappings[ds.exportId] = match.id;
      info(
        `  ${colors.dim('→')} ${ds.name} ${colors.dim(`(${ds.exportId})`)} → ${match.name} ${
          colors.dim(`(${match.id})`)
        }`,
      );
    } else {
      unmapped.push(ds);
    }
  }

  if (unmapped.length > 0) {
    throw new UserError(
      `Could not map ${unmapped.length} data source(s) to this org:\n` +
        unmapped.map((d) => `  ${d.exportId}  "${d.name}"`).join('\n') +
        `\nPass --map <exportId|name>=<source-ref> for each, or create the source first ` +
        `(dashboards sources create). Available sources:\n` +
        orgSources.slice(0, 25).map((s) => `  ${s.name} ${`(${s.id})`}`).join('\n'),
    );
  }

  // Computed fields (calculated fields + window dimensions) live on the SOURCE
  // and widgets reference them by name — the server-side import wires widgets
  // to the mapped sources but never touches those sources' schemas. Reconcile
  // here (additive: create missing, update drifted, never delete) so the
  // imported widgets' field refs actually resolve.
  const syncFields = opts.syncFields !== false;
  const sourcesById = new Map(orgSources.map((s) => [s.id, s]));
  const syncPlans: Array<{
    target: DashboardDataSource;
    actions: ReturnType<typeof planComputedFieldSync>;
  }> = [];
  if (syncFields) {
    for (const ds of payload.dataSources) {
      const target = sourcesById.get(mappings[ds.exportId]);
      if (!target) continue;
      const actions = planComputedFieldSync(
        {
          calculatedFields: ds.schema?.calculatedFields,
          windowDimensions: ds.schema?.windowDimensions,
        },
        target.recordSchema ?? {},
      ).filter((a) => a.action !== 'skip');
      if (actions.length > 0) syncPlans.push({ target, actions });
    }
  }

  const importBody = {
    ...payload,
    dashboard: {
      ...payload.dashboard,
      ...(opts.name ? { name: opts.name } : {}),
    },
    dataSourceMappings: mappings,
  };

  if (opts.dryRun) {
    for (const plan of syncPlans) {
      for (const a of plan.actions) {
        info(
          `  ${colors.dim('→')} would ${a.action} ${a.family} ${
            colors.bold(a.name)
          } on ${plan.target.name}`,
        );
      }
    }
    info(colors.dim('\n(dry-run) mappings resolved; not importing.'));
    if (opts.json) {
      console.log(JSON.stringify(
        {
          dataSourceMappings: mappings,
          fieldSync: syncPlans.map((p) => ({
            source: p.target.name,
            actions: p.actions.map((a) => ({ family: a.family, action: a.action, name: a.name })),
          })),
        },
        null,
        2,
      ));
    }
    return;
  }

  const fieldSyncResults: ComputedFieldSyncResult[] = [];
  for (const plan of syncPlans) {
    const results = await applyComputedFieldSync(client, plan.target.id, plan.actions);
    fieldSyncResults.push(...results);
    const tally = describeSyncResults(results);
    if (tally.created + tally.updated > 0) {
      info(
        `  ${
          colors.dim('→')
        } ${plan.target.name}: ${tally.created} field(s) created, ${tally.updated} updated`,
      );
    }
    for (const failure of tally.failures) {
      info(
        `  ${
          colors.yellow('⚠')
        } ${plan.target.name}: could not ${failure.action.action} ${failure.action.family} ` +
          `${colors.bold(failure.action.name)} — ${failure.error}. ` +
          `Widgets referencing it will not resolve.`,
      );
    }
  }

  const created = await apiFetch<DashboardWithWidgets>(
    client,
    '/dashboards/import',
    { method: 'POST', body: JSON.stringify(importBody) },
  );

  if (opts.json) {
    console.log(JSON.stringify(
      {
        ...created,
        ...(fieldSyncResults.length > 0
          ? {
            fieldSync: fieldSyncResults.map((r) => ({
              family: r.action.family,
              action: r.action.action,
              name: r.action.name,
              ok: r.ok,
              ...(r.error ? { error: r.error } : {}),
            })),
          }
          : {}),
      },
      null,
      2,
    ));
    return;
  }
  info(
    `${colors.green('✓')} imported ${colors.bold(created.name)} ${colors.dim(`(${created.id})`)}`,
  );
}
