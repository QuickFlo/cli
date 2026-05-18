/**
 * `quickflo environments list` — query the org's environments and print
 * either a human-readable table or JSON.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { openSession } from './session.ts';

interface EnvironmentRow {
  id: string;
  name: string;
  updatedAt?: string;
  variables?: Array<{ key: string }>;
}

interface EnvironmentListResponse {
  data: EnvironmentRow[];
  total: number;
}

async function fetchList(
  client: ApiClient,
  opts: ListOptions & { all: boolean },
): Promise<EnvironmentRow[]> {
  if (!opts.all) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    if (!params.has('options[limit]')) params.set('options[limit]', '50');
    const res = await apiFetch<EnvironmentListResponse>(
      client,
      `/environments?${params.toString()}`,
    );
    return res.data ?? [];
  }
  const pageSize = 100;
  let offset = 0;
  const all: EnvironmentRow[] = [];
  while (true) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    params.set('options[limit]', String(pageSize));
    params.set('options[offset]', String(offset));
    const res = await apiFetch<EnvironmentListResponse>(
      client,
      `/environments?${params.toString()}`,
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
  return iso ? iso.slice(0, 10) : '-';
}

function printTable(rows: EnvironmentRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no environments match)'));
    return;
  }
  const nameWidth = Math.min(40, Math.max(4, ...rows.map((r) => r.name.length)));
  const header = [
    'NAME'.padEnd(nameWidth),
    'VARS'.padStart(5),
    'UPDATED',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const vars = String(r.variables?.length ?? 0);
    console.log([
      truncate(r.name, nameWidth).padEnd(nameWidth),
      vars.padStart(5),
      formatDate(r.updatedAt),
    ].join('  '));
  }
}

export interface EnvironmentsListOptions extends ListOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  all?: boolean;
}

export async function runEnvironmentsList(
  opts: EnvironmentsListOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'environments list');
  const rows = await fetchList(client, {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order ?? 'updatedAt:DESC',
    all: opts.all ?? false,
  });
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error(
    colors.dim(
      `\n${org.name} (${org.suid ?? org.id}) — ${rows.length} environment(s)\n`,
    ),
  );
  printTable(rows);
}
