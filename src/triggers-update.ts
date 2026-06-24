/**
 * `quickflo triggers update <ref>` — PATCH `/triggers/:id`.
 *
 * `<ref>` is a UUID or a name. Use `-w <workflow>` to disambiguate
 * collisions across packages.
 *
 * Flags compose into the same PATCH body. `--from-file` provides `config`
 * (or anything else); `--name` and `--enabled true|false` override at the
 * top level. At least one mutation must be specified.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { openSession } from './session.ts';
import { resolveTriggerRef } from './trigger-refs.ts';

function parseBool(v: string): boolean {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new Error(`--enabled must be true|false (got "${v}")`);
}

export interface TriggersUpdateOptions {
  ref: string;
  workflow?: string;
  by?: Lookup;
  name?: string;
  enabled?: string;
  fromFile?: string;
  /**
   * New shared secret for token-auth webhooks. Sets `config.webhook.secret`;
   * the backend merge preserves the rest of the webhook config and re-encrypts
   * the value. Reuse the same value across triggers to share a token.
   */
  secret?: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runTriggersUpdate(
  opts: TriggersUpdateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers update');
  const resolved = await resolveTriggerRef(client, opts.ref, opts.workflow, opts.by);

  const body: Record<string, unknown> = opts.fromFile
    ? (JSON.parse(await Deno.readTextFile(opts.fromFile)) as Record<string, unknown>)
    : {};
  if (opts.name !== undefined) body['name'] = opts.name;
  if (opts.enabled !== undefined) body['enabled'] = parseBool(opts.enabled);

  // --secret sets the shared webhook token. Merge into config.webhook so it
  // composes with --from-file and the backend's partial-config merge preserves
  // path/method/etc.
  if (opts.secret !== undefined) {
    const config = (body['config'] && typeof body['config'] === 'object'
      ? body['config']
      : (body['config'] = {})) as Record<string, unknown>;
    const webhook = (config['webhook'] && typeof config['webhook'] === 'object'
      ? config['webhook']
      : (config['webhook'] = {})) as Record<string, unknown>;
    webhook['secret'] = opts.secret;
  }

  if (Object.keys(body).length === 0) {
    throw new Error(
      'Nothing to update — pass at least one of --name, --enabled, --secret, or --from-file',
    );
  }

  const trigger = await apiFetch<Record<string, unknown>>(
    client,
    `/triggers/${resolved.id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  console.error(
    `${colors.green('✓')} updated trigger ${colors.dim(resolved.id)}`,
  );
  console.log(JSON.stringify(trigger, null, 2));
}
