/**
 * `quickflo workflows executions restore <id>...` — undo a delete. Only
 * works while the row is still in the soft-archive window (the system
 * reaper hard-deletes after EXECUTION_TRACE_RETENTION_DAYS); past that
 * window the IDs are gone and the server returns 0 unarchived.
 *
 * Hits POST /execution-traces/bulk/unarchive in chunks of 500.
 */

import { colors } from '@cliffy/ansi/colors';
import { openSession } from './session.ts';
import { UserError } from './errors.ts';
import { bulkExecutionAction } from './workflows-executions-shared.ts';

export interface WorkflowsExecutionsRestoreOptions {
  ids: string[];
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsExecutionsRestore(
  opts: WorkflowsExecutionsRestoreOptions,
): Promise<void> {
  if (opts.ids.length === 0) {
    throw new UserError('Pass one or more execution IDs to restore.');
  }
  const { client } = await openSession(opts, 'workflows executions restore');

  const unarchived = await bulkExecutionAction(
    client,
    '/execution-traces/bulk/unarchive',
    opts.ids,
    'unarchived',
  );

  if (opts.json) {
    console.log(JSON.stringify({ unarchived, requested: opts.ids.length }, null, 2));
    return;
  }

  const skipped = opts.ids.length - unarchived;
  if (skipped > 0) {
    console.error(
      `${colors.green('✓')} ${unarchived} restored ${
        colors.dim(`(${skipped} skipped — past retention or not archived)`)
      }`,
    );
  } else {
    console.error(`${colors.green('✓')} ${unarchived} restored`);
  }
}
