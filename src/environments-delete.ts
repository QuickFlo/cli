/**
 * `quickflo environments delete <ref>` — delete an environment. Prompts to
 * confirm unless `--yes` is passed.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { resolveEnvironmentRef } from './environments-get.ts';
import { type Lookup } from './refs.ts';
import { openSession } from './session.ts';

export interface EnvironmentsDeleteOptions {
  ref: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runEnvironmentsDelete(
  opts: EnvironmentsDeleteOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'environments delete');
  const env = await resolveEnvironmentRef(client, opts.ref, opts.by);
  if (
    !await confirmDestructive(
      `Delete environment "${env.name}" in ${org.name}?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }
  await apiFetch(client, `/environments/${env.id}`, { method: 'DELETE' });
  console.error(
    `${colors.green('✓')} deleted environment ${colors.bold(env.name)} ${colors.dim(env.id)}`,
  );
}
