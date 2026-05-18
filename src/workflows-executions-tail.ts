/**
 * `quickflo workflows executions tail <id>` — poll an execution until it
 * reaches a terminal state (success / failed / cancelled), rendering live
 * progress to stderr. On completion, optionally persist the full trace
 * and/or fan out per-step output to disk.
 *
 * Exit codes mirror the underlying status:
 *   success    → 0
 *   failed     → 3  (ValidationError)
 *   cancelled  → 1  (UserError — server-initiated cancel)
 *   timeout    → 124 (client-side --timeout fired before terminal)
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { TimeoutError, UserError, ValidationError } from './errors.ts';
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

const TERMINAL = new Set(['success', 'failed', 'cancelled', 'error']);

function colorStatus(s: string): string {
  if (s === 'success') return colors.green(s);
  if (s === 'failed' || s === 'error') return colors.red(s);
  if (s === 'cancelled') return colors.yellow(s);
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
  const intervalMs = Math.max(250, (opts.interval ?? 2) * 1000);
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : undefined;
  const tty = isStdoutTTY();
  const started = Date.now();

  let last: ExecutionTrace | undefined;
  let lastStatus: string | undefined;
  let lastStepCount = -1;

  while (true) {
    const trace = await apiFetch<ExecutionTrace>(client, `/execution-traces/${opts.id}`);
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
  if (status === 'failed' || status === 'error') {
    const msg = typeof last.error === 'string' ? last.error : (last.error?.message ?? 'failed');
    throw new ValidationError(msg, { code: 'execution_failed', details: last });
  }
  if (status === 'cancelled') {
    throw new UserError(`Execution ${opts.id} was cancelled.`, { code: 'execution_cancelled' });
  }
}
