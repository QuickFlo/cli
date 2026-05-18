/**
 * `quickflo triggers delete <workflow> <id>` — delete a trigger. Confirm
 * unless `--yes`.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';

export interface TriggersDeleteOptions {
  workflow: string;
  id: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runTriggersDelete(
  opts: TriggersDeleteOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'triggers delete');
  const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
  if (
    !await confirmDestructive(
      `Delete trigger ${opts.id} from workflow "${wf.name}"?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }
  await apiFetch(client, `/workflows/${wf.id}/triggers/${opts.id}`, {
    method: 'DELETE',
  });
  console.error(
    `${colors.green('✓')} deleted trigger ${colors.dim(opts.id)}`,
  );
}
