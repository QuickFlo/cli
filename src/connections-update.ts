/**
 * `quickflo connections update <ref>` — PATCH /connections/:id.
 *
 * Updateable fields:
 *   - `--name <new>`            → rename
 *   - `--config '<json>'`       → swap the secret payload (API-key types only)
 *   - `--from-file <path>`      → same, from disk
 *
 * For OAuth-typed connections the config can't be authored as JSON; the
 * server requires a fresh authorize round-trip. We point users at
 * `connections create --type <provider> --name <existing-name>` (the
 * `/authorize` endpoint accepts a `connectionId` query param for re-auth,
 * but the user-facing path is the same `create` command).
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { listOAuthProviders } from './connections-oauth.ts';
import { detectLookup, type Lookup } from './refs.ts';
import { openSession } from './session.ts';

interface ConnectionRow {
  id: string;
  name: string;
  type: string;
}

interface ConnectionListResponse {
  data: ConnectionRow[];
}

async function fetchOne(
  client: ApiClient,
  ref: string,
  by: Lookup,
): Promise<ConnectionRow | null> {
  if (by === 'id') {
    try {
      return await apiFetch<ConnectionRow>(client, `/connections/${ref}`);
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

async function loadConfig(
  fromFile: string | undefined,
  inline: string | undefined,
): Promise<Record<string, unknown>> {
  const raw = fromFile ? await Deno.readTextFile(fromFile) : (inline as string);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export interface ConnectionsUpdateOptions {
  ref: string;
  by?: Lookup;
  name?: string;
  config?: string;
  fromFile?: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runConnectionsUpdate(
  opts: ConnectionsUpdateOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'connections update');
  const by = opts.by ?? detectLookup(opts.ref);
  const conn = await fetchOne(client, opts.ref, by);
  if (!conn) {
    console.error(
      colors.red(`No connection found where ${by}="${opts.ref}" in ${org.name}.`),
    );
    Deno.exit(1);
  }

  const wantsConfig = opts.config !== undefined || opts.fromFile !== undefined;
  if (wantsConfig) {
    const providers = await listOAuthProviders(client);
    if (providers.some((p) => p.id === conn.type)) {
      console.error(
        colors.red(
          `Connection "${conn.name}" is OAuth-based (${conn.type}); --config can't update it. Run \`quickflo connections create --type ${conn.type} --name "${conn.name}"\` to re-auth via browser.`,
        ),
      );
      Deno.exit(1);
    }
  }

  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body['name'] = opts.name;
  if (wantsConfig) body['config'] = await loadConfig(opts.fromFile, opts.config);
  if (Object.keys(body).length === 0) {
    throw new Error('Nothing to update — pass --name, --config, or --from-file.');
  }

  const updated = await apiFetch<ConnectionRow>(
    client,
    `/connections/${conn.id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  console.error(
    `${colors.green('✓')} updated connection ${colors.bold(updated.name)} ${
      colors.dim(updated.id)
    }`,
  );
  console.log(JSON.stringify(updated, null, 2));
}
