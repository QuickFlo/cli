/**
 * `quickflo triggers list [--workflow <ref>]` — list triggers.
 *
 * No `--workflow`: org-wide list via `GET /triggers`.
 * `--workflow <ref>`: scope to one workflow via `GET /workflows/:id/triggers`.
 *
 * When listing org-wide, the table replaces the workflow UUID with the
 * workflow name (batch-resolved in one round trip) and shows a PKG column
 * when any row was installed from a package — matching `workflows list`.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { resolveInstallAddresses } from './package-installs.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowNames, resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';

export interface TriggerRow {
  id: string;
  workflowId?: string;
  packageInstallId?: string | null;
  type: string;
  name?: string;
  enabled?: boolean;
  webhookUrl?: string;
  formUrl?: string;
  eventWebhookUrl?: string;
  lastTriggeredAt?: string;
  updatedAt?: string;
}

interface TriggerListResponse {
  data: TriggerRow[];
  total: number;
}

async function fetchTriggers(
  client: ApiClient,
  path: string,
  opts: ListOptions,
): Promise<TriggerRow[]> {
  const params = buildListParams(opts);
  const res = await apiFetch<TriggerListResponse>(
    client,
    `${path}?${params.toString()}`,
  );
  return res.data ?? [];
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : '-';
}

interface TableContext {
  showWorkflow: boolean;
  workflowNames: Map<string, string>;
  packageAddresses: Map<string, string>;
}

// YYYY-MM-DD == the header label "LAST FIRED" — both render as 10 chars.
const DATE_WIDTH = 'LAST FIRED'.length;

function printTable(rows: TriggerRow[], ctx: TableContext): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no triggers)'));
    return;
  }
  const showPackageColumn = rows.some((r) => r.packageInstallId);
  const nameWidth = Math.min(
    32,
    Math.max(4, ...rows.map((r) => (r.name ?? '').length)),
  );
  const typeWidth = Math.min(
    12,
    Math.max(4, ...rows.map((r) => r.type.length)),
  );
  const wfWidth = ctx.showWorkflow
    ? Math.min(
      32,
      Math.max(
        8,
        ...rows.map((r) =>
          (r.workflowId ? (ctx.workflowNames.get(r.workflowId) ?? r.workflowId) : '-').length
        ),
      ),
    )
    : 0;
  // PKG values are never truncated — uncapped width so slugs like
  // "@quickflo-tools/webex-tool-package@1.2.0" render in full while
  // still letting padEnd line up the next column.
  const pkgWidth = showPackageColumn
    ? Math.max(
      3,
      ...rows.map((r) =>
        r.packageInstallId ? (ctx.packageAddresses.get(r.packageInstallId) ?? '?').length : 1
      ),
    )
    : 0;

  const enabledWidth = 'ENABLED'.length;
  const headerParts = [
    'TYPE'.padEnd(typeWidth),
    'NAME'.padEnd(nameWidth),
    'ENABLED'.padEnd(enabledWidth),
    'LAST FIRED'.padEnd(DATE_WIDTH),
  ];
  if (ctx.showWorkflow) headerParts.push('WORKFLOW'.padEnd(wfWidth));
  if (showPackageColumn) headerParts.push('PKG'.padEnd(pkgWidth));
  headerParts.push('ID');
  const header = headerParts.join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const parts = [
      truncate(r.type, typeWidth).padEnd(typeWidth),
      truncate(r.name ?? '-', nameWidth).padEnd(nameWidth),
      (r.enabled === false ? 'no' : 'yes').padEnd(enabledWidth),
      formatDate(r.lastTriggeredAt).padEnd(DATE_WIDTH),
    ];
    if (ctx.showWorkflow) {
      const wfLabel = r.workflowId ? (ctx.workflowNames.get(r.workflowId) ?? r.workflowId) : '-';
      parts.push(truncate(wfLabel, wfWidth).padEnd(wfWidth));
    }
    if (showPackageColumn) {
      const addr = r.packageInstallId ? (ctx.packageAddresses.get(r.packageInstallId) ?? '?') : '-';
      parts.push(addr.padEnd(pkgWidth));
    }
    parts.push(r.id);
    console.log(parts.join('  '));
  }
}

export interface TriggersListOptions extends ListOptions {
  workflow?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runTriggersList(opts: TriggersListOptions): Promise<void> {
  const { client } = await openSession(opts, 'triggers list');

  let path: string;
  let header: string;
  let showWorkflow: boolean;
  if (opts.workflow) {
    const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
    path = `/workflows/${wf.id}/triggers`;
    header = `${wf.name}`;
    showWorkflow = false;
  } else {
    path = '/triggers';
    header = 'all workflows';
    showWorkflow = true;
  }

  const rows = await fetchTriggers(client, path, {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order ?? 'updatedAt:DESC',
  });
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Two batch lookups in parallel so the table can render names instead of IDs.
  const workflowIds = showWorkflow
    ? rows.map((r) => r.workflowId).filter((id): id is string => !!id)
    : [];
  const installIds = rows
    .map((r) => r.packageInstallId)
    .filter((id): id is string => !!id);
  const [workflowNames, packageAddresses] = await Promise.all([
    resolveWorkflowNames(client, workflowIds),
    resolveInstallAddresses(client, installIds),
  ]);

  console.error(
    colors.dim(`\n${header} — ${rows.length} trigger(s)\n`),
  );
  printTable(rows, { showWorkflow, workflowNames, packageAddresses });
}
