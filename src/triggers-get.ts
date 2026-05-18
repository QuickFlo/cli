/**
 * `quickflo triggers get <ref>` — fetch one trigger via the top-level
 * `/triggers/:id` endpoint. `<ref>` is a UUID or a name; pass
 * `-w <workflow>` to disambiguate when the same name lives on multiple
 * workflows (customer-owned vs. package-installed copies).
 */

import { type ApiClient, apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { openSession } from './session.ts';
import { resolveTriggerRef } from './trigger-refs.ts';
import { type TriggerRow } from './triggers-list.ts';

export async function fetchTrigger(
  client: ApiClient,
  triggerId: string,
): Promise<TriggerRow & Record<string, unknown>> {
  return await apiFetch<TriggerRow & Record<string, unknown>>(
    client,
    `/triggers/${triggerId}`,
  );
}

export interface TriggersGetOptions {
  ref: string;
  workflow?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersGet(opts: TriggersGetOptions): Promise<void> {
  const { client } = await openSession(opts, 'triggers get');
  const resolved = await resolveTriggerRef(client, opts.ref, opts.workflow, opts.by);
  const trigger = await fetchTrigger(client, resolved.id);
  console.log(JSON.stringify(trigger, null, 2));
}
