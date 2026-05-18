/**
 * `quickflo triggers create <workflow>` — create a trigger for a workflow.
 *
 * Mode A — minimal webhook (no `--from-file`):
 *   `triggers create <wf> --type webhook [--name X]`
 *   builds a default `{ type: 'webhook', config: { webhook: { method: POST, authType: token, ... } } }`
 *   payload server-side (same defaults as `workflows push -w`).
 *
 * Mode B — file (`--from-file <json>`):
 *   reads the JSON body verbatim and POSTs it. `--type` and `--name` override
 *   matching fields in the file when provided.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';

type TriggerType = 'webhook' | 'schedule' | 'event' | 'form';

const DEFAULT_WEBHOOK_CONFIG = {
  webhook: {
    method: 'POST',
    authType: 'token',
    timeout: 120000,
    exposeErrors: true,
  },
};

function buildMinimalPayload(
  type: TriggerType,
  name: string | undefined,
): Record<string, unknown> {
  if (type !== 'webhook') {
    throw new Error(
      `--type ${type} requires --from-file (only webhook has a minimal default)`,
    );
  }
  const body: Record<string, unknown> = {
    type: 'webhook',
    config: DEFAULT_WEBHOOK_CONFIG,
  };
  if (name) body['name'] = name;
  return body;
}

export interface TriggersCreateOptions {
  workflow: string;
  type?: TriggerType;
  name?: string;
  fromFile?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersCreate(
  opts: TriggersCreateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers create');
  const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);

  let body: Record<string, unknown>;
  if (opts.fromFile) {
    const raw = await Deno.readTextFile(opts.fromFile);
    body = JSON.parse(raw) as Record<string, unknown>;
    if (opts.type) body['type'] = opts.type;
    if (opts.name !== undefined) body['name'] = opts.name;
  } else {
    if (!opts.type) {
      throw new Error('--type is required when --from-file is not provided');
    }
    body = buildMinimalPayload(opts.type, opts.name);
  }

  const trigger = await apiFetch<Record<string, unknown>>(
    client,
    `/workflows/${wf.id}/triggers`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  console.error(
    `${colors.green('✓')} created ${body['type']} trigger ${colors.dim(String(trigger['id']))}`,
  );
  // Stdout = payload (URLs + secrets) so the user can pipe to a file.
  console.log(JSON.stringify(trigger, null, 2));
}
