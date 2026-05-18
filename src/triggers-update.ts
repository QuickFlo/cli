/**
 * `quickflo triggers update <workflow> <id>` — PATCH a trigger.
 *
 * Flags compose into the same PATCH body. `--from-file` provides `config`
 * (or anything else); `--name` and `--enabled true|false` override at the
 * top level. At least one mutation must be specified.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';

function parseBool(v: string): boolean {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new Error(`--enabled must be true|false (got "${v}")`);
}

export interface TriggersUpdateOptions {
  workflow: string;
  id: string;
  name?: string;
  enabled?: string;
  fromFile?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersUpdate(
  opts: TriggersUpdateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers update');
  const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);

  const body: Record<string, unknown> = opts.fromFile
    ? (JSON.parse(await Deno.readTextFile(opts.fromFile)) as Record<string, unknown>)
    : {};
  if (opts.name !== undefined) body['name'] = opts.name;
  if (opts.enabled !== undefined) body['enabled'] = parseBool(opts.enabled);

  if (Object.keys(body).length === 0) {
    throw new Error(
      'Nothing to update — pass at least one of --name, --enabled, or --from-file',
    );
  }

  const trigger = await apiFetch<Record<string, unknown>>(
    client,
    `/workflows/${wf.id}/triggers/${opts.id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  console.error(
    `${colors.green('✓')} updated trigger ${colors.dim(opts.id)}`,
  );
  console.log(JSON.stringify(trigger, null, 2));
}
