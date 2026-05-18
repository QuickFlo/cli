/**
 * Trigger lifecycle verbs:
 *   - `enable <wf> <id>`         → POST /:id/resume   (was `pause` flag)
 *   - `disable <wf> <id>`        → POST /:id/pause
 *   - `rotate-secret <wf> <id>`  → POST /:id/regenerate-secret (warns secret is shown ONCE)
 *   - `duplicate <wf> <id> --to <wf-ref> [--name X]`
 *
 * The `enable` / `disable` verbs map onto schedule trigger pause/resume on
 * the server (which also toggles `enabled`). Non-schedule triggers fall
 * through to a PATCH `{ enabled: ... }` so the verbs work uniformly.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';
import { fetchTrigger } from './triggers-get.ts';

interface TriggerWithSecret extends Record<string, unknown> {
  id: string;
  config?: {
    webhook?: { secret?: string };
  };
}

async function toggleTrigger(
  args: { workflow: string; id: string; enable: boolean } & {
    by?: Lookup;
    apiUrl?: string;
    orgId?: string;
  },
  label: string,
): Promise<void> {
  const { client } = await openSession(args, `triggers ${label}`);
  const wf = await resolveWorkflowRef(client, args.workflow, args.by);
  const existing = await fetchTrigger(client, wf.id, args.id);
  const action = args.enable ? 'resume' : 'pause';

  if (existing.type === 'schedule') {
    await apiFetch(client, `/workflows/${wf.id}/triggers/${args.id}/${action}`, {
      method: 'POST',
    });
  } else {
    await apiFetch(client, `/workflows/${wf.id}/triggers/${args.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: args.enable }),
    });
  }
  console.error(
    `${colors.green('✓')} ${args.enable ? 'enabled' : 'disabled'} trigger ${colors.dim(args.id)}`,
  );
}

export interface TriggersEnableOptions {
  workflow: string;
  id: string;
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
  workflow: string;
  id: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersRotateSecret(
  opts: TriggersRotateSecretOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers rotate-secret');
  const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
  const trigger = await apiFetch<TriggerWithSecret>(
    client,
    `/workflows/${wf.id}/triggers/${opts.id}/regenerate-secret`,
    { method: 'POST' },
  );
  console.error(
    `${colors.green('✓')} rotated secret for trigger ${colors.dim(opts.id)}`,
  );
  console.error(
    colors.yellow(
      '  ! secret shown once — capture it now (server encrypts after this response)',
    ),
  );
  console.log(JSON.stringify(trigger, null, 2));
}

export interface TriggersDuplicateOptions {
  workflow: string;
  id: string;
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
  const sourceWf = await resolveWorkflowRef(client, opts.workflow, opts.by);
  const targetWf = await resolveWorkflowRef(client, opts.to);
  const body: Record<string, unknown> = { targetWorkflowId: targetWf.id };
  if (opts.name !== undefined) body['name'] = opts.name;
  const trigger = await apiFetch<Record<string, unknown>>(
    client,
    `/workflows/${sourceWf.id}/triggers/${opts.id}/duplicate`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  console.error(
    `${colors.green('✓')} duplicated trigger ${colors.dim(opts.id)} → ${
      colors.dim(String(trigger['id']))
    } on ${targetWf.name}`,
  );
  console.log(JSON.stringify(trigger, null, 2));
}
