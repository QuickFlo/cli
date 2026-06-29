/**
 * `quickflo dashboards list` — list the org's dashboards as a table or JSON.
 *
 * The dashboard list endpoint returns the whole org-scoped set with no
 * server-side filtering, so `--name` is a client-side substring match and
 * `--include-packages` toggles whether package-installed dashboards are shown
 * (default: org-owned only, mirroring `workflows list`).
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { type Dashboard } from './dashboards-refs.ts';
import { openSession } from './session.ts';

interface DashboardListRow extends Dashboard {
  widgetCount?: number;
}

export interface DashboardsListOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  name?: string;
  includePackages?: boolean;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatDate(iso?: string): string {
  if (!iso) return '-';
  return iso.slice(0, 10);
}

export async function runDashboardsList(
  opts: DashboardsListOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'dashboards list');
  let rows = await apiFetch<DashboardListRow[]>(client, '/dashboards');

  if (!opts.includePackages) {
    rows = rows.filter((d) => !d.packageInstallId);
  }
  if (opts.name) {
    const needle = opts.name.toLowerCase();
    rows = rows.filter((d) => d.name.toLowerCase().includes(needle));
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.error(
    colors.dim(`\n${org.name} (${org.suid ?? org.id}) — ${rows.length} dashboard(s)\n`),
  );
  if (rows.length === 0) {
    console.log(colors.dim('(no dashboards match)'));
    return;
  }

  const nameWidth = Math.min(40, Math.max(4, ...rows.map((r) => r.name.length)));
  const headerCells = [
    'NAME'.padEnd(nameWidth),
    'WIDGETS'.padStart(7),
    'DFLT'.padEnd(4),
    'UUID'.padEnd(36),
    'UPDATED',
  ];
  const header = headerCells.join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const widgets = r.widgetCount ?? (r.layout?.length ?? 0);
    console.log([
      truncate(r.name, nameWidth).padEnd(nameWidth),
      String(widgets).padStart(7),
      (r.isDefault ? 'yes' : 'no').padEnd(4),
      r.id.padEnd(36),
      formatDate(r.updatedAt),
    ].join('  '));
  }
}
