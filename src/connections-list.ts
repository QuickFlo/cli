/**
 * `quickflo connections list` — query the org's connections and print either
 * a human-readable table or JSON. Mirrors `workflows list`.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { openSession } from './session.ts';

interface ConnectionRow {
  id: string;
  name: string;
  type: string;
  updatedAt?: string;
  oauth?: { email?: string; name?: string };
}

interface ConnectionListResponse {
  data: ConnectionRow[];
  total: number;
}

async function fetchList(
  client: ApiClient,
  opts: ListOptions & { all: boolean },
): Promise<ConnectionRow[]> {
  if (!opts.all) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    if (!params.has('options[limit]')) {
      params.set('options[limit]', '50');
    }
    const res = await apiFetch<ConnectionListResponse>(
      client,
      `/connections?${params.toString()}`,
    );
    return res.data ?? [];
  }
  const pageSize = 100;
  let offset = 0;
  const all: ConnectionRow[] = [];
  while (true) {
    const params = buildListParams(opts);
    params.set('where[organizationId][$eq]', client.orgId);
    params.set('options[limit]', String(pageSize));
    params.set('options[offset]', String(offset));
    const res = await apiFetch<ConnectionListResponse>(
      client,
      `/connections?${params.toString()}`,
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

function printTable(rows: ConnectionRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no connections match)'));
    return;
  }
  const nameWidth = Math.min(40, Math.max(4, ...rows.map((r) => r.name.length)));
  const typeWidth = Math.min(24, Math.max(4, ...rows.map((r) => r.type.length)));
  const header = [
    'NAME'.padEnd(nameWidth),
    'TYPE'.padEnd(typeWidth),
    'UPDATED',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    console.log([
      truncate(r.name, nameWidth).padEnd(nameWidth),
      truncate(r.type, typeWidth).padEnd(typeWidth),
      formatDate(r.updatedAt),
    ].join('  '));
  }
}

export interface ConnectionsListOptions extends ListOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  all?: boolean;
}

export async function runConnectionsList(
  opts: ConnectionsListOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'connections list');

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
      `\n${org.name} (${org.suid ?? org.id}) — ${rows.length} connection(s)\n`,
    ),
  );
  printTable(rows);
}
