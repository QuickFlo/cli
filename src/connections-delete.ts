/**
 * `quickflo connections delete <ref>` — delete a connection. Prompts to
 * confirm unless `--yes` is passed.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
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

export interface ConnectionsDeleteOptions {
  ref: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runConnectionsDelete(
  opts: ConnectionsDeleteOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'connections delete');
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

  if (
    !await confirmDestructive(
      `Delete connection "${conn.name}" (${conn.type}) in ${org.name}?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }

  await apiFetch(client, `/connections/${conn.id}`, { method: 'DELETE' });
  console.error(
    `${colors.green('✓')} deleted connection ${colors.bold(conn.name)} ${colors.dim(conn.id)}`,
  );
}
