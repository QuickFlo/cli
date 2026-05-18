/**
 * `quickflo connections test <ref>` — stub that POSTs to the (future)
 * `/connections/:id/test` endpoint. Until the platform ships that endpoint,
 * the command surfaces a clear "not yet supported" error so scripts can rely
 * on the flag set being stable.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { ApiError, UserError } from './errors.ts';
import { detectLookup } from './refs.ts';

interface ConnectionRow {
  id: string;
  name: string;
  type: string;
}

interface ConnectionListResponse {
  data: ConnectionRow[];
}

async function resolveConnection(client: ApiClient, ref: string): Promise<ConnectionRow> {
  const by = detectLookup(ref);
  const params = new URLSearchParams();
  params.set(`where[${by}][$eq]`, ref);
  params.set('options[limit]', '1');
  const res = await apiFetch<ConnectionListResponse>(
    client,
    `/connections?${params.toString()}`,
  );
  const conn = res.data?.[0];
  if (!conn) throw new UserError(`No connection found where ${by}="${ref}".`);
  return conn;
}

export interface ConnectionsTestOptions {
  ref: string;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runConnectionsTest(opts: ConnectionsTestOptions): Promise<void> {
  const { client } = await openSession(opts, 'connections test');
  const conn = await resolveConnection(client, opts.ref);

  try {
    const res = await apiFetch<unknown>(client, `/connections/${conn.id}/test`, {
      method: 'POST',
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(colors.green(`✓ ${conn.name} (${conn.type}) — connection test passed`));
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new UserError(
        `Server does not support POST /connections/:id/test yet (tracked at bd-1ub6). ` +
          `Workaround: run a workflow that uses this connection.`,
        { code: 'not_implemented_on_server' },
      );
    }
    throw err;
  }
}
