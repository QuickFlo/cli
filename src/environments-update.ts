/**
 * `quickflo environments update <ref> --name <new>` — rename an environment.
 * Variable edits are handled by `environments set` / `unset` / `push --prune`.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { resolveEnvironmentRef } from './environments-get.ts';
import { type Lookup } from './refs.ts';
import { openSession } from './session.ts';

export interface EnvironmentsUpdateOptions {
  ref: string;
  by?: Lookup;
  name?: string;
  apiUrl?: string;
  orgId?: string;
}

export async function runEnvironmentsUpdate(
  opts: EnvironmentsUpdateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'environments update');
  if (opts.name === undefined) {
    throw new Error('Nothing to update — pass --name <new>.');
  }
  const env = await resolveEnvironmentRef(client, opts.ref, opts.by);
  const updated = await apiFetch<{ id: string; name: string }>(
    client,
    `/environments/${env.id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name: opts.name }),
    },
  );
  console.error(
    `${colors.green('✓')} renamed environment ${colors.dim(env.id)} → ${colors.bold(updated.name)}`,
  );
  console.log(JSON.stringify(updated, null, 2));
}
