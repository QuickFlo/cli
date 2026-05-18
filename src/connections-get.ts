/**
 * `quickflo connections get <ref>` — print one connection's pushable JSON
 * (name, type, settings, decrypted config) to stdout.
 *
 * Plaintext config by default — matches industry CLIs (gcloud, vault, doppler,
 * 1password) where pulling a credential locally returns the real value so it
 * can be edited and pushed back without ceremony. `--mask` replaces each
 * config value with `"***"` for safe inspection.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { detectLookup, type Lookup } from './refs.ts';
import { openSession } from './session.ts';

export interface ConnectionRecord {
  id: string;
  name: string;
  type: string;
  oauth?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ConnectionListResponse {
  data: ConnectionRecord[];
}

async function fetchOne(
  client: ApiClient,
  ref: string,
  by: Lookup,
): Promise<ConnectionRecord | null> {
  // The /:id route only accepts a UUID; for name lookup we fall back to list.
  if (by === 'id') {
    try {
      return await apiFetch<ConnectionRecord>(client, `/connections/${ref}`);
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set(`where[${by}][$eq]`, ref);
  params.set('options[limit]', '1');
  const res = await apiFetch<ConnectionListResponse>(
    client,
    `/connections?${params.toString()}`,
  );
  return res.data?.[0] ?? null;
}

export async function fetchConfig(
  client: ApiClient,
  id: string,
): Promise<Record<string, unknown>> {
  return await apiFetch<Record<string, unknown>>(
    client,
    `/connections/${id}/config`,
  );
}

export function maskConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(config)) out[k] = '***';
  return out;
}

export function toPushableShape(
  c: ConnectionRecord,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: c.name,
    type: c.type,
    config,
  };
  if (c.settings) out['settings'] = c.settings;
  return out;
}

export interface ConnectionsGetOptions {
  ref: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  mask?: boolean;
}

export async function runConnectionsGet(
  opts: ConnectionsGetOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'connections get');

  const by = opts.by ?? detectLookup(opts.ref);
  const conn = await fetchOne(client, opts.ref, by);
  if (!conn) {
    console.error(
      colors.red(
        `No connection found where ${by}="${opts.ref}" in ${org.name}.`,
      ),
    );
    Deno.exit(1);
  }

  const rawConfig = await fetchConfig(client, conn.id);
  const config = opts.mask ? maskConfig(rawConfig) : rawConfig;

  const output = opts.json ? { ...conn, config } : toPushableShape(conn, config);
  console.log(JSON.stringify(output, null, 2));
}
