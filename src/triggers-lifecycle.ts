/**
 * Trigger lifecycle verbs:
 *   - `enable <ref>`         → POST /:wfId/triggers/:id/resume (schedule) or PATCH /triggers/:id
 *   - `disable <ref>`        → POST /:wfId/triggers/:id/pause   (schedule) or PATCH /triggers/:id
 *   - `rotate-secret <ref>`  → POST /:wfId/triggers/:id/regenerate-secret (secret shown ONCE)
 *   - `duplicate <ref> --to <wf-ref> [--name X]`
 *
 * `<ref>` is a UUID or a name; use `-w <workflow>` to disambiguate
 * collisions. The pause/resume/regenerate-secret/duplicate endpoints are
 * only mounted under `/workflows/:wfId/triggers/:id/...`, so for those we
 * fetch the trigger by ID first to discover its workflowId and then
 * dispatch to the nested verb. Callers never have to know the workflow ref.
 *
 * For non-schedule triggers, `enable`/`disable` fall through to a top-level
 * `PATCH /triggers/:id` with `{ enabled }` — no workflow lookup at all.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';
import { fetchTrigger } from './triggers-get.ts';
import { resolveTriggerRef } from './trigger-refs.ts';

interface TriggerWithSecret extends Record<string, unknown> {
  id: string;
  config?: {
    webhook?: { secret?: string };
  };
}

async function toggleTrigger(
  args: { ref: string; enable: boolean } & {
    workflow?: string;
    by?: Lookup;
    apiUrl?: string;
    orgId?: string;
  },
  label: string,
): Promise<void> {
  const { client } = await openSession(args, `triggers ${label}`);
  const resolved = await resolveTriggerRef(client, args.ref, args.workflow, args.by);
  const existing = await fetchTrigger(client, resolved.id);
  const action = args.enable ? 'resume' : 'pause';

  if (existing.type === 'schedule') {
    const workflowId = (existing['workflowId'] as string | undefined) ?? resolved.workflowId;
    if (!workflowId) {
      throw new Error(
        `Trigger ${resolved.id} has no workflowId — cannot ${action} schedule.`,
      );
    }
    await apiFetch(
      client,
      `/workflows/${workflowId}/triggers/${resolved.id}/${action}`,
      { method: 'POST' },
    );
  } else {
    await apiFetch(client, `/triggers/${resolved.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: args.enable }),
    });
  }
  console.error(
    `${colors.green('✓')} ${args.enable ? 'enabled' : 'disabled'} trigger ${
      colors.dim(resolved.id)
    }`,
  );
}

export interface TriggersEnableOptions {
  ref: string;
  workflow?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export function runTriggersEnable(opts: TriggersEnableOptions): Promise<void> {
  return toggleTrigger({ ...opts, enable: true }, 'enable');
}

export function runTriggersDisable(opts: TriggersEnableOptions): Promise<void> {
  return toggleTrigger({ ...opts, enable: false }, 'disable');
}

export interface TriggersRotateSecretOptions {
  ref: string;
  workflow?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersRotateSecret(
  opts: TriggersRotateSecretOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers rotate-secret');
  const resolved = await resolveTriggerRef(client, opts.ref, opts.workflow, opts.by);
  const existing = await fetchTrigger(client, resolved.id);
  const workflowId = (existing['workflowId'] as string | undefined) ?? resolved.workflowId;
  if (!workflowId) {
    throw new Error(
      `Trigger ${resolved.id} has no workflowId — cannot rotate secret.`,
    );
  }
  const trigger = await apiFetch<TriggerWithSecret>(
    client,
    `/workflows/${workflowId}/triggers/${resolved.id}/regenerate-secret`,
    { method: 'POST' },
  );
  console.error(
    `${colors.green('✓')} rotated secret for trigger ${colors.dim(resolved.id)}`,
  );
  console.error(
    colors.yellow(
      '  ! secret shown once — capture it now (server encrypts after this response)',
    ),
  );
  console.log(JSON.stringify(trigger, null, 2));
}

export interface TriggersDuplicateOptions {
  ref: string;
  workflow?: string;
  to: string;
  name?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersDuplicate(
  opts: TriggersDuplicateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers duplicate');
  const resolved = await resolveTriggerRef(client, opts.ref, opts.workflow, opts.by);
  const existing = await fetchTrigger(client, resolved.id);
  const sourceWorkflowId = (existing['workflowId'] as string | undefined) ?? resolved.workflowId;
  if (!sourceWorkflowId) {
    throw new Error(
      `Trigger ${resolved.id} has no workflowId — cannot duplicate.`,
    );
  }
  const targetWf = await resolveWorkflowRef(client, opts.to);
  const body: Record<string, unknown> = { targetWorkflowId: targetWf.id };
  if (opts.name !== undefined) body['name'] = opts.name;
  const trigger = await apiFetch<Record<string, unknown>>(
    client,
    `/workflows/${sourceWorkflowId}/triggers/${resolved.id}/duplicate`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  console.error(
    `${colors.green('✓')} duplicated trigger ${colors.dim(resolved.id)} → ${
      colors.dim(String(trigger['id']))
    } on ${targetWf.name}`,
  );
  console.log(JSON.stringify(trigger, null, 2));
}
