/**
 * `quickflo workflows list` — query the org's workflows and print either a
 * human-readable table or JSON.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import {
  applyTagsFilter,
  applyTemplateFilter,
  buildListParams,
  type ListOptions,
  parseTags,
  type TagsMode,
  type TemplateFilter,
} from './filters.ts';
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
}

interface WorkflowListResponse {
  data: WorkflowRow[];
  total: number;
}

interface FetchFilters {
  templateFilter: TemplateFilter;
  tags: string[];
  tagsMode: TagsMode;
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

function printTable(rows: WorkflowRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no workflows match)'));
    return;
  }
  const nameWidth = Math.min(
    40,
    Math.max(4, ...rows.map((r) => r.name.length)),
  );
  const tagsWidth = Math.min(
    30,
    Math.max(4, ...rows.map((r) => (r.tags ?? []).join(',').length)),
  );
  const header = [
    'SUID'.padEnd(6),
    'NAME'.padEnd(nameWidth),
    'STEPS'.padStart(5),
    'TMPL'.padEnd(4),
    'TAGS'.padEnd(tagsWidth),
    'UPDATED',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const steps = r.definition?.steps?.length ?? 0;
    const tags = (r.tags ?? []).join(',');
    console.log(
      [
        (r.suid ?? '-').padEnd(6),
        truncate(r.name, nameWidth).padEnd(nameWidth),
        String(steps).padStart(5),
        (r.isTemplate ? 'yes' : 'no').padEnd(4),
        truncate(tags || '-', tagsWidth).padEnd(tagsWidth),
        formatDate(r.updatedAt),
      ].join('  '),
    );
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
  });

  // Payload → stdout; everything else (banner, count summary) → stderr.
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error(
    colors.dim(
      `\n${org.name} (${org.suid ?? org.id}) — ${rows.length} workflow(s)\n`,
    ),
  );
  printTable(rows);
}
