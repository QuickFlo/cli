/**
 * `quickflo connections create --type <type> --name <name> [--config '<json>' | --from-file <path>]`
 *
 * Two paths:
 *   - API-key / static-credential types → POST /connections with the config inline.
 *   - OAuth-typed types → delegate to runOAuthSubflow (browser handoff + poll).
 *
 * Refuses to mix the two: passing `--config` to an OAuth type fails with a
 * pointer to the browser flow. Validates `--type` against
 * `GET /connections/types/list` and errors with the available list inline
 * when the type is unknown.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { listOAuthProviders, runOAuthSubflow } from './connections-oauth.ts';
import { openSession } from './session.ts';

interface TypesListResponse {
  types: string[];
}

async function fetchKnownTypes(client: ApiClient): Promise<string[]> {
  const res = await apiFetch<TypesListResponse>(client, `/connections/types/list`);
  return res.types ?? [];
}

async function loadInlineConfig(
  fromFile: string | undefined,
  inline: string | undefined,
): Promise<Record<string, unknown>> {
  let raw: string;
  if (fromFile) {
    raw = await Deno.readTextFile(fromFile);
  } else if (inline !== undefined) {
    raw = inline;
  } else {
    throw new Error(
      "Provide --config '<json>' or --from-file <path> for non-OAuth connection types.",
    );
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export interface ConnectionsCreateOptions {
  type: string;
  name: string;
  config?: string;
  fromFile?: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runConnectionsCreate(
  opts: ConnectionsCreateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'connections create');

  const [knownTypes, providers] = await Promise.all([
    fetchKnownTypes(client),
    listOAuthProviders(client),
  ]);
  if (!knownTypes.includes(opts.type)) {
    throw new Error(
      `Unknown connection type "${opts.type}". Available: ${knownTypes.join(', ')}`,
    );
  }
  const isOAuth = providers.some((p) => p.id === opts.type);

  if (isOAuth) {
    if (opts.config !== undefined || opts.fromFile !== undefined) {
      throw new Error(
        `Type "${opts.type}" is OAuth-based — omit --config / --from-file. The browser flow handles the secret end-to-end.`,
      );
    }
    const conn = await runOAuthSubflow({
      providerId: opts.type,
      connectionName: opts.name,
      client,
    });
    console.error(
      `${colors.green('✓')} created connection ${colors.bold(conn.name)} ${colors.dim(conn.id)}`,
    );
    console.log(JSON.stringify(conn, null, 2));
    return;
  }

  const config = await loadInlineConfig(opts.fromFile, opts.config);
  const created = await apiFetch<{ id: string; name: string; type: string }>(
    client,
    `/connections`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        type: opts.type,
        config,
        organizationId: client.orgId,
      }),
    },
  );
  console.error(
    `${colors.green('✓')} created connection ${colors.bold(created.name)} ${
      colors.dim(created.id)
    }`,
  );
  console.log(JSON.stringify(created, null, 2));
}
