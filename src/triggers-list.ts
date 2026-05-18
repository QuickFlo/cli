/**
 * `quickflo triggers list <workflow>` — list triggers for one workflow.
 * Workflow ref accepts UUID, SUID, or name (same grammar as `workflows get`).
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';

export interface TriggerRow {
  id: string;
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
  workflowId: string,
  opts: ListOptions,
): Promise<TriggerRow[]> {
  const params = buildListParams(opts);
  const res = await apiFetch<TriggerListResponse>(
    client,
    `/workflows/${workflowId}/triggers?${params.toString()}`,
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

function printTable(rows: TriggerRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no triggers)'));
    return;
  }
  const nameWidth = Math.min(
    32,
    Math.max(4, ...rows.map((r) => (r.name ?? '').length)),
  );
  const typeWidth = Math.min(
    12,
    Math.max(4, ...rows.map((r) => r.type.length)),
  );
  const header = [
    'TYPE'.padEnd(typeWidth),
    'NAME'.padEnd(nameWidth),
    'ON'.padEnd(3),
    'LAST FIRED',
    'ID',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    console.log([
      truncate(r.type, typeWidth).padEnd(typeWidth),
      truncate(r.name ?? '-', nameWidth).padEnd(nameWidth),
      (r.enabled === false ? 'no' : 'yes').padEnd(3),
      formatDate(r.lastTriggeredAt),
      r.id,
    ].join('  '));
  }
}

export interface TriggersListOptions extends ListOptions {
  workflow: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runTriggersList(opts: TriggersListOptions): Promise<void> {
  const { client } = await openSession(opts, 'triggers list');
  const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
  const rows = await fetchTriggers(client, wf.id, {
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
  console.error(
    colors.dim(`\n${wf.name} — ${rows.length} trigger(s)\n`),
  );
  printTable(rows);
}
