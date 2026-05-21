/**
 * `quickflo workflows executions delete <id>...` — delete (soft-archive)
 * one or more execution traces. Running executions in the set are
 * automatically cancelled by the server as part of the archive operation,
 * so callers don't need to cancel-then-delete.
 *
 * Two input modes (same shape as `executions cancel`):
 *   - explicit IDs
 *   - filter mode (--workflow / --status / --since / --where)
 *
 * Hits POST /execution-traces/bulk/archive in chunks of 500.
 */

import { colors } from '@cliffy/ansi/colors';
import { confirmDestructive } from './confirm.ts';
import { openSession } from './session.ts';
import { UserError } from './errors.ts';
import { type Lookup } from './refs.ts';
import {
  bulkExecutionAction,
  type ExecutionFilterOptions,
  fetchMatchingTraces,
} from './workflows-executions-shared.ts';

export interface WorkflowsExecutionsDeleteOptions extends ExecutionFilterOptions {
  ids?: string[];
  yes?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  workflow?: string;
  by?: Lookup;
}

function hasAnyFilter(opts: WorkflowsExecutionsDeleteOptions): boolean {
  return Boolean(
    opts.workflow || opts.status || opts.since || (opts.where && opts.where.length > 0),
  );
}

export async function runWorkflowsExecutionsDelete(
  opts: WorkflowsExecutionsDeleteOptions,
): Promise<void> {
  const ids = opts.ids ?? [];
  const filterMode = hasAnyFilter(opts);

  if (ids.length === 0 && !filterMode) {
    throw new UserError(
      'Pass one or more execution IDs, or a filter (--workflow / --status / --since / --where).',
    );
  }
  if (ids.length > 0 && filterMode) {
    throw new UserError('Use either explicit IDs or a filter, not both.');
  }

  const { client, org } = await openSession(opts, 'workflows executions delete');

  let targetIds = ids;
  if (filterMode) {
    const rows = await fetchMatchingTraces(client, opts, opts.limit);
    targetIds = rows.map((r) => r.id);
    if (targetIds.length === 0) {
      console.error(colors.dim('(no matching executions)'));
      if (opts.json) console.log(JSON.stringify({ archived: 0, requested: 0 }, null, 2));
      return;
    }
    const sample = rows.slice(0, 5).map((r) =>
      `    ${colors.dim(r.id.slice(0, 8))}  ${r.workflowName ?? '—'}  ${r.status ?? '—'}`
    ).join('\n');
    console.error(`Found ${colors.bold(String(targetIds.length))} matching execution(s):`);
    console.error(sample);
    if (targetIds.length > 5) console.error(colors.dim(`    … and ${targetIds.length - 5} more`));
  }

  const prompt = targetIds.length === 1
    ? `Delete execution ${targetIds[0]} in ${org.name}?`
    : `Delete ${targetIds.length} execution(s) in ${org.name}?`;
  if (!await confirmDestructive(prompt, opts.yes)) {
    console.error(colors.dim('aborted.'));
    return;
  }

  const archived = await bulkExecutionAction(
    client,
    '/execution-traces/bulk/archive',
    targetIds,
    'archived',
  );

  if (opts.json) {
    console.log(JSON.stringify({ archived, requested: targetIds.length }, null, 2));
    return;
  }

  const skipped = targetIds.length - archived;
  if (skipped > 0) {
    console.error(
      `${colors.green('✓')} ${archived} deleted ${
        colors.dim(`(${skipped} skipped — already gone)`)
      }`,
    );
  } else {
    console.error(`${colors.green('✓')} ${archived} deleted`);
  }
}
