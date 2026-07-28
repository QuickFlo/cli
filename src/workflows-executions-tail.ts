/**
 * `quickflo workflows executions tail <id>` — poll an execution until it
 * reaches a terminal state, rendering live progress to stderr. On completion,
 * optionally persist the full trace and/or fan out per-step output to disk.
 *
 * Exit codes mirror the underlying status:
 *   success               → 0
 *   completed_with_errors → 0  (run finished; step errors were tolerated by
 *                               continueOnError — warned on stderr)
 *   failed                → 3  (ValidationError)
 *   timed_out             → 3  (ValidationError — server-side execution timeout)
 *   cancelled             → 1  (UserError — server-initiated cancel)
 *   rejected              → 1  (UserError — refused before it ran)
 *   timeout               → 124 (client-side --timeout fired before terminal)
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { ApiError, TimeoutError, UserError, ValidationError } from './errors.ts';
import { isStdoutTTY } from './tty.ts';
import { saveSteps, saveTrace } from './trace-save.ts';

interface ExecutionTrace {
  id: string;
  workflowId?: string;
  workflowName?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  durationMilliseconds?: number;
  stepPaths?: Record<string, string>;
  error?: { message?: string } | string;
}

/**
 * Statuses a run can no longer move out of, mirroring the server's
 * `ExecutionStatus` enum (`libs/execution-traces/.../execution-trace.model.ts`).
 *
 * Deliberately EXCLUDED, because the run can still progress and polling should
 * continue: `running`, plus `crashed` and `suspended` — both are resumable, so
 * the wake/claim machinery may still carry them to a terminal state.
 *
 * `error` is not a server status; it is kept only as a defensive alias for
 * older API responses.
 */
const TERMINAL = new Set([
  'success',
  'completed_with_errors',
  'failed',
  'cancelled',
  'rejected',
  'timed_out',
  'error',
]);

function colorStatus(s: string): string {
  if (s === 'success') return colors.green(s);
  if (s === 'failed' || s === 'error' || s === 'timed_out' || s === 'rejected') return colors.red(s);
  if (s === 'cancelled' || s === 'completed_with_errors') return colors.yellow(s);
  if (s === 'running') return colors.cyan(s);
  return s;
}

function renderProgressLine(trace: ExecutionTrace, elapsedMs: number, tty: boolean): string {
  const status = colorStatus(trace.status ?? 'pending');
  const stepCount = Object.keys(trace.stepPaths ?? {}).length;
  const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
  const line = `  [${status}] steps=${stepCount} · elapsed=${elapsed}`;
  return tty ? `\r${line}` : line;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkflowsExecutionsTailOptions {
  id: string;
  interval?: number;
  timeout?: number;
  saveTrace?: string;
  saveStepsTo?: string;
  showSecrets?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsExecutionsTail(
  opts: WorkflowsExecutionsTailOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'workflows executions tail');
  await tailExecution(client, opts);
}

/**
 * Poll an execution until terminal, rendering progress to stderr and
 * honoring --timeout / --save-trace / --save-steps-to / --json. Throws
 * ValidationError on failure, UserError on cancel, TimeoutError on deadline —
 * so callers inherit the tail exit-code contract. Exported so `workflows run`
 * (which queues then waits) reuses the exact tail behavior on its own session.
 */
export async function tailExecution(
  client: ApiClient,
  opts: Omit<WorkflowsExecutionsTailOptions, 'apiUrl' | 'orgId'>,
): Promise<void> {
  const intervalMs = Math.max(250, (opts.interval ?? 2) * 1000);
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : undefined;
  const tty = isStdoutTTY();
  const started = Date.now();

  let last: ExecutionTrace | undefined;
  let lastStatus: string | undefined;
  let lastStepCount = -1;

  // A freshly queued execution has no trace row until a worker claims the
  // job, so early polls can 404. Treat 404 as "pending" for a bounded grace
  // window instead of failing the tail.
  const notFoundGraceMs = 60_000;

  while (true) {
    let trace: ExecutionTrace;
    try {
      trace = await apiFetch<ExecutionTrace>(client, `/execution-traces/${opts.id}`);
    } catch (err) {
      const elapsed = Date.now() - started;
      const withinGrace = elapsed < Math.min(notFoundGraceMs, timeoutMs ?? notFoundGraceMs);
      if (err instanceof ApiError && err.status === 404 && withinGrace) {
        await sleep(intervalMs);
        continue;
      }
      throw err;
    }
    last = trace;
    const status = trace.status ?? 'pending';
    const stepCount = Object.keys(trace.stepPaths ?? {}).length;
    const elapsed = Date.now() - started;

    if (opts.json) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), elapsedMs: elapsed, trace }));
    } else if (status !== lastStatus || stepCount !== lastStepCount) {
      const line = renderProgressLine(trace, elapsed, tty);
      if (tty) {
        await Deno.stderr.write(new TextEncoder().encode(line));
      } else {
        console.error(line);
      }
    }
    lastStatus = status;
    lastStepCount = stepCount;

    if (TERMINAL.has(status)) {
      if (tty && !opts.json) await Deno.stderr.write(new TextEncoder().encode('\n'));
      break;
    }
    if (timeoutMs !== undefined && elapsed > timeoutMs) {
      if (tty && !opts.json) await Deno.stderr.write(new TextEncoder().encode('\n'));
      throw new TimeoutError(
        `Execution ${opts.id} did not reach a terminal state within ${opts.timeout}s.`,
      );
    }
    await sleep(intervalMs);
  }

  if (!last) {
    throw new UserError(`No data returned for execution ${opts.id}.`);
  }

  if (opts.saveTrace) {
    const path = await saveTrace(client, opts.id, opts.saveTrace, opts.showSecrets);
    console.error(colors.dim(`wrote trace → ${path}`));
  }
  if (opts.saveStepsTo) {
    const paths = await saveSteps(client, opts.id, opts.saveStepsTo, opts.showSecrets);
    console.error(colors.dim(`wrote ${paths.length} step file(s) → ${opts.saveStepsTo}/`));
  }

  if (opts.json) {
    const final = await apiFetch<ExecutionTrace>(client, `/execution-traces/${opts.id}`);
    console.log(JSON.stringify(final, null, 2));
  } else {
    const duration = last.durationMilliseconds !== undefined
      ? `${last.durationMilliseconds}ms`
      : `${((Date.now() - started) / 1000).toFixed(1)}s`;
    console.error(
      `${colorStatus(last.status ?? '—')} · ${
        Object.keys(last.stepPaths ?? {}).length
      } step(s) · ${duration}`,
    );
  }

  const status = last.status ?? '';
  if (status === 'failed' || status === 'error' || status === 'timed_out') {
    const msg = typeof last.error === 'string' ? last.error : (last.error?.message ?? status);
    throw new ValidationError(msg, { code: 'execution_failed', details: last });
  }
  if (status === 'cancelled') {
    throw new UserError(`Execution ${opts.id} was cancelled.`, { code: 'execution_cancelled' });
  }
  if (status === 'rejected') {
    throw new UserError(`Execution ${opts.id} was rejected before it ran.`, {
      code: 'execution_rejected',
      details: last,
    });
  }
  // `completed_with_errors` exits 0 on purpose: the run finished, and it only
  // reaches this state when the author set `continueOnError` on the step that
  // failed — i.e. the failure was explicitly tolerated. Without that opt-in the
  // run would have ended `failed` (exit 3). Warn so it is never silent.
  if (status === 'completed_with_errors' && !opts.json) {
    console.error(
      colors.yellow(
        `! Execution ${opts.id} completed with step errors that were tolerated by continueOnError.`,
      ),
    );
  }
}
