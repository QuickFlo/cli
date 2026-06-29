/**
 * `quickflo dashboards pull` — download dashboards to a local directory as
 * self-contained native JSON files (real IDs preserved), one per dashboard.
 * Round-trips with `dashboards push` within the same org: edit the JSON, push
 * it back, widgets and layout reconcile by id.
 *
 * Each file embeds the referenced data-source definitions under `dataSources`
 * for context (and so `push --create-missing-sources` can recreate them). For
 * cross-org moves use `dashboards export`/`import`, which remap source ids.
 *
 * Server-managed fields (organizationId, dashboardId, timestamps,
 * packageInstallId) are stripped so the file is a clean editable surface; ids
 * stay because they are the round-trip key.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import {
  type DashboardDataSource,
  type DashboardWithWidgets,
  fetchDataSources,
} from './dashboards-refs.ts';
import { collectSourceIds } from './dashboards-get.ts';
import { info } from './log.ts';
import { openSession } from './session.ts';

const DASHBOARD_DROP = [
  'organizationId',
  'createdAt',
  'updatedAt',
  'packageInstallId',
  'widgets',
];
const WIDGET_DROP = ['organizationId', 'dashboardId', 'createdAt', 'updatedAt'];
const SOURCE_DROP = ['organizationId', 'createdAt', 'updatedAt', 'packageInstallId'];

function omit(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'dashboard';
}

/** Deterministic filenames; disambiguate collisions with a short id suffix. */
function assignFilenames(dashboards: DashboardWithWidgets[]): Map<string, string> {
  const slugCounts = new Map<string, number>();
  for (const d of dashboards) {
    const slug = slugify(d.name);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const d of dashboards) {
    const slug = slugify(d.name);
    const name = (slugCounts.get(slug) ?? 0) > 1
      ? `${slug}.${d.id.slice(0, 8)}.json`
      : `${slug}.json`;
    result.set(d.id, name);
  }
  return result;
}

function buildFileShape(
  dash: DashboardWithWidgets,
  sourcesById: Map<string, DashboardDataSource>,
): Record<string, unknown> {
  const widgets = (dash.widgets ?? []).map((w) =>
    omit(w as unknown as Record<string, unknown>, WIDGET_DROP)
  );
  const referenced = collectSourceIds(dash)
    .map((id) => sourcesById.get(id))
    .filter((d): d is DashboardDataSource => !!d)
    .map((d) => omit(d as unknown as Record<string, unknown>, SOURCE_DROP));

  const base = omit(dash as unknown as Record<string, unknown>, DASHBOARD_DROP);
  return { ...base, widgets, dataSources: referenced };
}

export interface DashboardsPullOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  name?: string;
  includePackages?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

export async function runDashboardsPull(
  opts: DashboardsPullOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'dashboards pull');

  let list = await apiFetch<DashboardWithWidgets[]>(client, '/dashboards');
  if (!opts.includePackages) {
    list = list.filter((d) => !d.packageInstallId);
  }
  if (opts.name) {
    const needle = opts.name.toLowerCase();
    list = list.filter((d) => d.name.toLowerCase().includes(needle));
  }

  // The list endpoint omits widgets; fetch each dashboard in full.
  const full: DashboardWithWidgets[] = [];
  for (const d of list) {
    full.push(await apiFetch<DashboardWithWidgets>(client, `/dashboards/${d.id}`));
  }

  const allSources = await fetchDataSources(client);
  const sourcesById = new Map(allSources.map((s) => [s.id, s]));

  const filenames = assignFilenames(full);

  info(colors.dim(`\n${org.name} — ${full.length} dashboard(s) → ${opts.dir}\n`));

  if (!opts.dryRun) {
    await Deno.mkdir(opts.dir, { recursive: true });
  }

  let written = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const dash of full) {
    const filename = filenames.get(dash.id);
    if (!filename) continue;
    const path = `${opts.dir}/${filename}`;
    const shape = buildFileShape(dash, sourcesById);
    const json = JSON.stringify(shape, null, 2) + '\n';

    let existing: string | null = null;
    try {
      existing = await Deno.readTextFile(path);
    } catch {
      existing = null;
    }

    if (existing !== null && existing === json) {
      unchanged++;
      info(`  ${colors.dim('=')} ${filename} ${colors.dim('(unchanged)')}`);
      continue;
    }
    if (existing !== null && !opts.force) {
      skipped++;
      info(
        `  ${colors.yellow('!')} ${filename} ${colors.dim('(differs — use --force to overwrite)')}`,
      );
      continue;
    }

    if (opts.dryRun) {
      written++;
      info(`  ${colors.green('+')} ${filename} ${colors.dim('(dry-run)')}`);
      continue;
    }
    await Deno.writeTextFile(path, json);
    written++;
    info(`  ${colors.green('+')} ${filename}`);
  }

  info(
    colors.dim(
      `\n${written} written, ${unchanged} unchanged, ${skipped} skipped.`,
    ),
  );
}
