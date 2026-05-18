/**
 * `quickflo triggers delete <ref>` — delete via `/triggers/:id`. Confirm
 * unless `--yes`. `<ref>` is a UUID or a name (use `-w` to disambiguate).
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { type Lookup } from './refs.ts';
import { openSession } from './session.ts';
import { resolveTriggerRef } from './trigger-refs.ts';

export interface TriggersDeleteOptions {
  ref: string;
  workflow?: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runTriggersDelete(
  opts: TriggersDeleteOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers delete');
  const resolved = await resolveTriggerRef(client, opts.ref, opts.workflow, opts.by);
  if (
    !await confirmDestructive(
      `Delete trigger ${resolved.id}?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }
  await apiFetch(client, `/triggers/${resolved.id}`, { method: 'DELETE' });
  console.error(
    `${colors.green('✓')} deleted trigger ${colors.dim(resolved.id)}`,
  );
}
