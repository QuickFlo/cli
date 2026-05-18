/**
 * `quickflo triggers get <workflow> <id>` — fetch one trigger including the
 * computed `webhookUrl` / `formUrl` / `eventWebhookUrl` fields.
 */

import { type ApiClient, apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';
import { type TriggerRow } from './triggers-list.ts';

export async function fetchTrigger(
  client: ApiClient,
  workflowId: string,
  triggerId: string,
): Promise<TriggerRow & Record<string, unknown>> {
  return await apiFetch<TriggerRow & Record<string, unknown>>(
    client,
    `/workflows/${workflowId}/triggers/${triggerId}`,
  );
}

export interface TriggersGetOptions {
  workflow: string;
  id: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersGet(opts: TriggersGetOptions): Promise<void> {
  const { client } = await openSession(opts, 'triggers get');
  const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
  const trigger = await fetchTrigger(client, wf.id, opts.id);
  console.log(JSON.stringify(trigger, null, 2));
}
