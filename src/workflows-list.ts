/**
 * `quickflo workflows list` — query the org's workflows and print either a
 * human-readable table or JSON.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import {
  applyPackageFilter,
  applyTagsFilter,
  applyTemplateFilter,
  buildListParams,
  type ListOptions,
  parseTags,
  type TagsMode,
  type TemplateFilter,
} from './filters.ts';
import { resolveInstallAddresses } from './package-installs.ts';
import { openSession } from './session.ts';

interface WorkflowRow {
  id: string;
  suid?: string;
  name: string;
  description?: string;
  updatedAt?: string;
  definition?: { steps?: unknown[] };
  isTemplate?: boolean;
  tags?: string[];
  packageInstallId?: string | null;
}

interface WorkflowListResponse {
  data: WorkflowRow[];
  total: number;
}

interface FetchFilters {
  templateFilter: TemplateFilter;
  tags: string[];
  tagsMode: TagsMode;
  includePackages: boolean;
}

async function fetchList(
  client: ApiClient,
  opts: ListOptions & { all: boolean } & FetchFilters,
): Promise<WorkflowRow[]> {
  if (!opts.all) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    applyTemplateFilter(params, opts.templateFilter);
    applyTagsFilter(params, opts.tags, opts.tagsMode);
    applyPackageFilter(params, opts.includePackages);
    if (!params.has('options[limit]')) {
      params.set('options[limit]', '50');
    }
    const res = await apiFetch<WorkflowListResponse>(
      client,
      `/workflows?${params.toString()}`,
    );
    return res.data ?? [];
  }
  const pageSize = 100;
  let offset = 0;
  const all: WorkflowRow[] = [];
  while (true) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    applyTemplateFilter(params, opts.templateFilter);
    applyTagsFilter(params, opts.tags, opts.tagsMode);
    applyPackageFilter(params, opts.includePackages);
    params.set('options[limit]', String(pageSize));
    params.set('options[offset]', String(offset));
    const res = await apiFetch<WorkflowListResponse>(
      client,
      `/workflows?${params.toString()}`,
    );
    const page = res.data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatDate(iso?: string): string {
  if (!iso) return '-';
  return iso.slice(0, 10);
}

function printTable(
  rows: WorkflowRow[],
  packageAddresses: Map<string, string>,
): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no workflows match)'));
    return;
  }
  // PKG column only when at least one row originates from a package — keeps
  // the default (org-only) view as compact as it was before.
  const showPackageColumn = rows.some((r) => r.packageInstallId);
  const nameWidth = Math.min(
    40,
    Math.max(4, ...rows.map((r) => r.name.length)),
  );
  const tagsWidth = Math.min(
    30,
    Math.max(4, ...rows.map((r) => (r.tags ?? []).join(',').length)),
  );
  const pkgWidth = showPackageColumn
    ? Math.min(
      30,
      Math.max(
        3,
        ...rows.map((r) =>
          r.packageInstallId ? (packageAddresses.get(r.packageInstallId) ?? '?').length : 1
        ),
      ),
    )
    : 0;
  const headerCells = [
    'SUID'.padEnd(6),
    'NAME'.padEnd(nameWidth),
    'STEPS'.padStart(5),
    'TMPL'.padEnd(4),
    'TAGS'.padEnd(tagsWidth),
  ];
  if (showPackageColumn) headerCells.push('PKG'.padEnd(pkgWidth));
  headerCells.push('UPDATED');
  const header = headerCells.join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const steps = r.definition?.steps?.length ?? 0;
    const tags = (r.tags ?? []).join(',');
    const cells = [
      (r.suid ?? '-').padEnd(6),
      truncate(r.name, nameWidth).padEnd(nameWidth),
      String(steps).padStart(5),
      (r.isTemplate ? 'yes' : 'no').padEnd(4),
      truncate(tags || '-', tagsWidth).padEnd(tagsWidth),
    ];
    if (showPackageColumn) {
      const addr = r.packageInstallId ? (packageAddresses.get(r.packageInstallId) ?? '?') : '-';
      cells.push(truncate(addr, pkgWidth).padEnd(pkgWidth));
    }
    cells.push(formatDate(r.updatedAt));
    console.log(cells.join('  '));
  }
}

export interface WorkflowsListOptions extends ListOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  all?: boolean;
  /** `all` includes templates + workflows (default), `only` = templates only, `exclude` = workflows only. */
  templates?: TemplateFilter;
  /** Comma-separated tag list (or repeated flag). Matches workflows with any of these tags by default. */
  tags?: string | string[];
  /** Require all tags to be present (AND) rather than any (OR, default). */
  tagsAll?: boolean;
  /** Include workflows installed from packages. Defaults to false (org-owned only). */
  includePackages?: boolean;
}

export async function runWorkflowsList(
  opts: WorkflowsListOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'list');

  const rows = await fetchList(client, {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order ?? 'updatedAt:DESC',
    all: opts.all ?? false,
    templateFilter: opts.templates ?? 'all',
    tags: parseTags(opts.tags),
    tagsMode: opts.tagsAll ? 'all' : 'any',
    includePackages: opts.includePackages ?? false,
  });

  // Payload → stdout; everything else (banner, count summary) → stderr.
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Skip the install-resolve round-trip if no rows came from a package.
  const installIds = rows
    .map((r) => r.packageInstallId)
    .filter((id): id is string => !!id);
  const packageAddresses = await resolveInstallAddresses(client, installIds);

  console.error(
    colors.dim(
      `\n${org.name} (${org.suid ?? org.id}) — ${rows.length} workflow(s)\n`,
    ),
  );
  printTable(rows, packageAddresses);
}
