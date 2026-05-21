/**
 * `quickflo workflows executions cancel <id>...` — request graceful
 * cancellation of one or more in-flight executions.
 *
 * Two input modes:
 *   - explicit IDs (variadic positional args)
 *   - filter mode (--workflow / --status / --since / --where), in which case
 *     we resolve to the matching ID set client-side, then POST to
 *     /execution-traces/bulk/cancel.
 *
 * The single-id and bulk forms both hit /bulk/cancel for consistent
 * "silent skip non-RUNNING" semantics — the server reports the number it
 * actually transitioned, which may be less than the input count. We
 * surface that count honestly.
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

export interface WorkflowsExecutionsCancelOptions extends ExecutionFilterOptions {
  ids?: string[];
  yes?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  workflow?: string;
  by?: Lookup;
}

function hasAnyFilter(opts: WorkflowsExecutionsCancelOptions): boolean {
  return Boolean(
    opts.workflow || opts.status || opts.since || (opts.where && opts.where.length > 0),
  );
}

export async function runWorkflowsExecutionsCancel(
  opts: WorkflowsExecutionsCancelOptions,
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

  const { client, org } = await openSession(opts, 'workflows executions cancel');

  let targetIds = ids;
  if (filterMode) {
    const rows = await fetchMatchingTraces(client, opts, opts.limit);
    targetIds = rows.map((r) => r.id);
    if (targetIds.length === 0) {
      console.error(colors.dim('(no matching executions)'));
      if (opts.json) console.log(JSON.stringify({ cancelled: 0, requested: 0 }, null, 2));
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
    ? `Cancel execution ${targetIds[0]} in ${org.name}?`
    : `Cancel ${targetIds.length} execution(s) in ${org.name}?`;
  if (!await confirmDestructive(prompt, opts.yes)) {
    console.error(colors.dim('aborted.'));
    return;
  }

  const cancelled = await bulkExecutionAction(
    client,
    '/execution-traces/bulk/cancel',
    targetIds,
    'cancelled',
  );

  if (opts.json) {
    console.log(JSON.stringify({ cancelled, requested: targetIds.length }, null, 2));
    return;
  }

  const skipped = targetIds.length - cancelled;
  if (cancelled === 0) {
    console.error(
      `${colors.yellow('—')} 0 cancelled ${colors.dim(`(${targetIds.length} not running)`)}`,
    );
  } else if (skipped > 0) {
    console.error(
      `${colors.green('✓')} ${cancelled} cancelled ${
        colors.dim(`(${skipped} skipped — not running)`)
      }`,
    );
  } else {
    console.error(`${colors.green('✓')} ${cancelled} cancelled`);
  }
}
