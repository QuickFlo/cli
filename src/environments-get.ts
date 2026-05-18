/**
 * `quickflo environments get <ref>` — print one environment's pushable JSON
 * (name + decrypted variables) to stdout. Plaintext by default; `--mask`
 * redacts each value to `"***"` for safe inspection.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { detectLookup, type Lookup } from './refs.ts';
import { openSession } from './session.ts';

export interface EnvironmentRecord {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface EnvironmentListResponse {
  data: EnvironmentRecord[];
}

async function fetchOne(
  client: ApiClient,
  ref: string,
  by: Lookup,
): Promise<EnvironmentRecord | null> {
  if (by === 'id') {
    try {
      return await apiFetch<EnvironmentRecord>(client, `/environments/${ref}`);
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set(`where[${by}][$eq]`, ref);
  params.set('options[limit]', '1');
  const res = await apiFetch<EnvironmentListResponse>(
    client,
    `/environments?${params.toString()}`,
  );
  return res.data?.[0] ?? null;
}

export async function fetchVariables(
  client: ApiClient,
  id: string,
): Promise<Record<string, string>> {
  return await apiFetch<Record<string, string>>(
    client,
    `/environments/${id}/variables`,
  );
}

export async function fetchVariableKeys(
  client: ApiClient,
  id: string,
): Promise<string[]> {
  return await apiFetch<string[]>(
    client,
    `/environments/${id}/variable-keys`,
  );
}

export function maskVariables(
  vars: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(vars)) out[k] = '***';
  return out;
}

export function toPushableShape(
  env: EnvironmentRecord,
  variables: Record<string, string>,
): Record<string, unknown> {
  return { name: env.name, variables };
}

export async function resolveEnvironmentRef(
  client: ApiClient,
  ref: string,
  by?: Lookup,
): Promise<EnvironmentRecord> {
  const lookup = by ?? detectLookup(ref);
  const env = await fetchOne(client, ref, lookup);
  if (!env) {
    throw new Error(`No environment found where ${lookup}="${ref}".`);
  }
  return env;
}

export interface EnvironmentsGetOptions {
  ref: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  mask?: boolean;
}

export async function runEnvironmentsGet(
  opts: EnvironmentsGetOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'environments get');
  const by = opts.by ?? detectLookup(opts.ref);
  const env = await fetchOne(client, opts.ref, by);
  if (!env) {
    console.error(
      colors.red(
        `No environment found where ${by}="${opts.ref}" in ${org.name}.`,
      ),
    );
    Deno.exit(1);
  }
  const raw = await fetchVariables(client, env.id);
  const variables = opts.mask ? maskVariables(raw) : raw;
  const output = opts.json ? { ...env, variables } : toPushableShape(env, variables);
  console.log(JSON.stringify(output, null, 2));
}
