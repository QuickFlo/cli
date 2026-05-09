/**
 * `quickflo packages list` — list packages this org has published, or
 * packages installed into this org. Two modes via `--installed` flag.
 *
 * Default (`--published`): GET /packages scoped to caller's active org.
 * Alt (`--installed`): GET /package-installs (auto-scoped to active org by
 * the controller) — returns an envelope with side-loaded Package + Version
 * rows so we can render slug + version columns without per-row fetches.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { type EnvName } from './config.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { openSession } from './session.ts';

interface PackageRow {
  id: string;
  slug: string;
  name: string;
  description?: string;
  visibility: 'public' | 'unlisted' | 'private';
  tags?: string[];
  latestVersionId?: string;
  updatedAt?: string;
}

interface PackageVersionRow {
  id: string;
  packageId: string;
  version: string;
  unlistedInstallToken?: string;
  createdAt?: string;
}

interface PackageInstallRow {
  id: string;
  packageId: string;
  packageVersionId: string;
  installedAt: string;
  installedResources?: Array<{ kind: string }>;
  setupChecklist?: Array<{ completedAt?: string | null }>;
}

interface PackagesListResponse {
  data: PackageRow[];
  total: number;
}

interface PackageInstallsListResponse {
  data: PackageInstallRow[];
  packages: PackageRow[];
  versions: PackageVersionRow[];
  total: number;
}

async function fetchPublished(
  client: ApiClient,
  opts: ListOptions & { all: boolean },
): Promise<PackageRow[]> {
  if (!opts.all) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    if (!params.has('options[limit]')) {
      params.set('options[limit]', '50');
    }
    const res = await apiFetch<PackagesListResponse>(
      client,
      `/packages?${params.toString()}`,
    );
    return res.data ?? [];
  }
  const pageSize = 100;
  let offset = 0;
  const all: PackageRow[] = [];
  while (true) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    params.set('options[limit]', String(pageSize));
    params.set('options[offset]', String(offset));
    const res = await apiFetch<PackagesListResponse>(
      client,
      `/packages?${params.toString()}`,
    );
    const page = res.data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

interface InstalledRow {
  install: PackageInstallRow;
  pkg?: PackageRow;
  version?: PackageVersionRow;
}

async function fetchInstalled(
  client: ApiClient,
  opts: ListOptions & { all: boolean },
): Promise<InstalledRow[]> {
  const collect: InstalledRow[] = [];
  const pageSize = opts.all ? 100 : (opts.limit ?? 50);
  let offset = 0;

  while (true) {
    const params = buildListParams(opts);
    params.set('options[limit]', String(pageSize));
    if (offset > 0) params.set('options[offset]', String(offset));

    const res = await apiFetch<PackageInstallsListResponse>(
      client,
      `/package-installs?${params.toString()}`,
    );

    const pkgById = new Map((res.packages ?? []).map((p) => [p.id, p]));
    const versionById = new Map((res.versions ?? []).map((v) => [v.id, v]));
    const data = res.data ?? [];

    for (const install of data) {
      collect.push({
        install,
        pkg: pkgById.get(install.packageId),
        version: versionById.get(install.packageVersionId),
      });
    }

    if (!opts.all || data.length < pageSize) break;
    offset += pageSize;
  }
  return collect;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatDate(iso?: string): string {
  if (!iso) return '-';
  return iso.slice(0, 10);
}

function printPublishedTable(rows: PackageRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no packages published)'));
    return;
  }
  const slugWidth = Math.min(
    36,
    Math.max(4, ...rows.map((r) => r.slug.length)),
  );
  const nameWidth = Math.min(
    32,
    Math.max(4, ...rows.map((r) => r.name.length)),
  );
  const header = [
    'SLUG'.padEnd(slugWidth),
    'NAME'.padEnd(nameWidth),
    'VISIBILITY'.padEnd(10),
    'UPDATED',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    console.log(
      [
        truncate(r.slug, slugWidth).padEnd(slugWidth),
        truncate(r.name, nameWidth).padEnd(nameWidth),
        r.visibility.padEnd(10),
        formatDate(r.updatedAt),
      ].join('  '),
    );
  }
}

function printInstalledTable(rows: InstalledRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no packages installed)'));
    return;
  }
  const slugWidth = Math.min(
    36,
    Math.max(4, ...rows.map((r) => (r.pkg?.slug ?? '?').length)),
  );
  const nameWidth = Math.min(
    32,
    Math.max(4, ...rows.map((r) => (r.pkg?.name ?? '?').length)),
  );
  const header = [
    'SLUG'.padEnd(slugWidth),
    'NAME'.padEnd(nameWidth),
    'VERSION'.padEnd(10),
    'TODOS'.padStart(5),
    'INSTALLED',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const todos = (r.install.setupChecklist ?? []).filter(
      (t) => !t.completedAt,
    ).length;
    console.log(
      [
        truncate(r.pkg?.slug ?? '(unknown)', slugWidth).padEnd(slugWidth),
        truncate(r.pkg?.name ?? '(unknown)', nameWidth).padEnd(nameWidth),
        (r.version?.version ?? '?').padEnd(10),
        String(todos).padStart(5),
        formatDate(r.install.installedAt),
      ].join('  '),
    );
  }
}

export interface PackagesListOptions extends ListOptions {
  env: EnvName;
  apiUrl?: string;
  orgId?: string;
  username?: string;
  password?: string;
  json?: boolean;
  all?: boolean;
  noCache?: boolean;
  /** When true, list installed packages (PackageInstall rows). Default: false (Published). */
  installed?: boolean;
}

export async function runPackagesList(
  opts: PackagesListOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'packages list');

  const listOpts = {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order ?? 'updatedAt:DESC',
    all: opts.all ?? false,
  };

  if (opts.installed) {
    const rows = await fetchInstalled(client, listOpts);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.error(
      colors.dim(
        `\n${org.name} (${org.suid ?? org.id}) — ${rows.length} installed package(s)\n`,
      ),
    );
    printInstalledTable(rows);
    return;
  }

  const rows = await fetchPublished(client, listOpts);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error(
    colors.dim(
      `\n${org.name} (${org.suid ?? org.id}) — ${rows.length} published package(s)\n`,
    ),
  );
  printPublishedTable(rows);
}
