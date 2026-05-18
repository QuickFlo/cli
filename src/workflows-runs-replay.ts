/**
 * `quickflo workflows runs replay <run-id>` — re-execute a workflow with the
 * same `initial` it had on the original run. Reads the stored trace, locates
 * the input under known fields (`metadata.initial`, root `initial`, or
 * `__input__` step output), then delegates to `runWorkflowsRun`.
 *
 * If the input isn't where we expect, fails with a clear message asking the
 * user to pass `--input` / `--input-file` explicitly.
 */

import { apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { UserError } from './errors.ts';
import { runWorkflowsRun } from './workflows-run.ts';

interface ExecutionTrace {
  id: string;
  workflowId?: string;
  workflowName?: string;
  workflowSuid?: string;
  metadata?: Record<string, unknown> & { initial?: Record<string, unknown> };
  initial?: Record<string, unknown>;
}

function locateInitial(trace: unknown): Record<string, unknown> | undefined {
  if (!trace || typeof trace !== 'object') return undefined;
  const t = trace as Record<string, unknown>;
  const candidates: unknown[] = [
    t['initial'],
    (t['metadata'] as Record<string, unknown> | undefined)?.['initial'],
    (t['steps'] as Record<string, unknown> | undefined)?.['__input__'],
    (t['stepResults'] as Record<string, unknown> | undefined)?.['__input__'],
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      return c as Record<string, unknown>;
    }
  }
  return undefined;
}

export interface WorkflowsRunsReplayOptions {
  id: string;
  mode?: 'sync' | 'async';
  env?: string;
  timeout?: number;
  show?: string[];
  hide?: string[];
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsRunsReplay(
  opts: WorkflowsRunsReplayOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'workflows runs replay');
  const trace = await apiFetch<ExecutionTrace>(client, `/execution-traces/${opts.id}`);
  let initial = locateInitial(trace);

  if (!initial) {
    const data = await apiFetch<unknown>(
      client,
      `/execution-traces/${opts.id}/trace-data`,
    );
    initial = locateInitial(data);
  }

  if (!initial) {
    throw new UserError(
      `Could not locate the original \`initial\` input in trace ${opts.id}. ` +
        `Pass it explicitly via \`workflows run <wf> --input '{...}'\`.`,
    );
  }
  if (!trace.workflowId && !trace.workflowSuid && !trace.workflowName) {
    throw new UserError(`Trace ${opts.id} has no associated workflow reference.`);
  }

  const ref = trace.workflowSuid ?? trace.workflowId ?? trace.workflowName!;
  await runWorkflowsRun({
    ref,
    input: JSON.stringify(initial),
    mode: opts.mode,
    env: opts.env,
    timeout: opts.timeout,
    show: opts.show,
    hide: opts.hide,
    apiUrl: opts.apiUrl,
    orgId: opts.orgId,
    json: opts.json,
  });
}
