/**
 * `quickflo workflows delete <ref>` — delete a workflow via `/workflows/:id`.
 * `<ref>` is a UUID, SUID, or name (auto-detected; force with `--by`).
 * Confirms unless `--yes`. Deleting a workflow removes its triggers and
 * execution history along with it.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { type Lookup } from './refs.ts';
import { openSession } from './session.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';

export interface WorkflowsDeleteOptions {
  ref: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runWorkflowsDelete(
  opts: WorkflowsDeleteOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'workflows delete');
  const wf = await resolveWorkflowRef(client, opts.ref, opts.by);

  if (
    !await confirmDestructive(
      `Delete workflow "${wf.name}" (and its triggers + execution history) in ${org.name}?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }

  await apiFetch(client, `/workflows/${wf.id}`, { method: 'DELETE' });
  console.error(
    `${colors.green('✓')} deleted workflow ${colors.bold(wf.name)} ${colors.dim(wf.id)}`,
  );
}
