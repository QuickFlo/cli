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
  type DashboardDataSource,
  type DashboardWithWidgets,
  fetchDataSources,
} from './dashboards-refs.ts';
import { UserError } from './errors.ts';
import { info } from './log.ts';
import { UUID_RE } from './refs.ts';
import { openSession } from './session.ts';

interface ExportedSource {
  exportId: string;
  name: string;
  schema?: { name?: string };
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

  const importBody = {
    ...payload,
    dashboard: {
      ...payload.dashboard,
      ...(opts.name ? { name: opts.name } : {}),
    },
    dataSourceMappings: mappings,
  };

  if (opts.dryRun) {
    info(colors.dim('\n(dry-run) mappings resolved; not importing.'));
    if (opts.json) console.log(JSON.stringify({ dataSourceMappings: mappings }, null, 2));
    return;
  }

  const created = await apiFetch<DashboardWithWidgets>(
    client,
    '/dashboards/import',
    { method: 'POST', body: JSON.stringify(importBody) },
  );

  if (opts.json) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  info(
    `${colors.green('✓')} imported ${colors.bold(created.name)} ${colors.dim(`(${created.id})`)}`,
  );
}
