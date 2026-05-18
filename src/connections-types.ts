/**
 * `quickflo connections types` — table of registered connection types, joined
 *   with `GET /connections/oauth/providers` so each row tells the user
 *   whether the type takes an API key or runs through OAuth (and via which
 *   provider).
 * `quickflo connections types schema <type>` — for API-key types, prints the
 *   JSON Schema. For OAuth types, prints `{ oauth: true, provider, scopes }`
 *   so callers know to use `connections create` instead of authoring config
 *   directly.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';

interface TypesListResponse {
  types: string[];
}

interface ProvidersResponse {
  providers: Array<{
    id: string;
    name?: string;
    scopes?: string[];
  }>;
}

interface TypeSchemaResponse {
  type: string;
  schema: unknown;
}

interface Row {
  type: string;
  auth: 'oauth' | 'config';
  provider?: string;
}

function buildRows(
  types: string[],
  providers: ProvidersResponse['providers'],
): Row[] {
  const oauthIds = new Map(providers.map((p) => [p.id, p]));
  return types
    .map((t) => {
      const oauth = oauthIds.get(t);
      return oauth
        ? { type: t, auth: 'oauth' as const, provider: oauth.name ?? oauth.id }
        : { type: t, auth: 'config' as const };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}

function printTable(rows: Row[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no connection types)'));
    return;
  }
  const typeWidth = Math.max(4, ...rows.map((r) => r.type.length));
  const authWidth = Math.max(4, ...rows.map((r) => r.auth.length));
  const header = [
    'TYPE'.padEnd(typeWidth),
    'AUTH'.padEnd(authWidth),
    'PROVIDER',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    console.log([
      r.type.padEnd(typeWidth),
      r.auth.padEnd(authWidth),
      r.provider ?? '-',
    ].join('  '));
  }
}

export interface ConnectionsTypesListOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runConnectionsTypesList(
  opts: ConnectionsTypesListOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'connections types');
  const [types, providers] = await Promise.all([
    apiFetch<TypesListResponse>(client, `/connections/types/list`),
    apiFetch<ProvidersResponse>(client, `/connections/oauth/providers`),
  ]);
  const rows = buildRows(types.types ?? [], providers.providers ?? []);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error(colors.dim(`\n${rows.length} connection type(s)\n`));
  printTable(rows);
}

export interface ConnectionsTypesSchemaOptions {
  type: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runConnectionsTypesSchema(
  opts: ConnectionsTypesSchemaOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'connections types schema');
  const providers = await apiFetch<ProvidersResponse>(
    client,
    `/connections/oauth/providers`,
  );
  const oauth = (providers.providers ?? []).find((p) => p.id === opts.type);
  if (oauth) {
    console.log(JSON.stringify(
      {
        type: opts.type,
        oauth: true,
        provider: oauth.id,
        providerName: oauth.name ?? oauth.id,
        scopes: oauth.scopes ?? [],
        note:
          'Run `quickflo connections create --type <type> --name <name>` to authorize via browser.',
      },
      null,
      2,
    ));
    return;
  }
  const res = await apiFetch<TypeSchemaResponse>(
    client,
    `/connections/types/${encodeURIComponent(opts.type)}/schema`,
  );
  console.log(JSON.stringify(res.schema, null, 2));
}
