/**
 * `quickflo workflows executions get <id>` — fetch one execution trace and
 * render top-level metadata + step paths.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';

interface ExecutionTrace {
  id: string;
  workflowId?: string;
  workflowName?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  durationMilliseconds?: number;
  traceStorageUri?: string;
  stepPaths?: Record<string, string>;
  metadata?: Record<string, unknown>;
  error?: { message?: string } | string;
}

export interface WorkflowsExecutionsGetOptions {
  id: string;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

function colorStatus(s: string): string {
  if (s === 'success') return colors.green(s);
  if (s === 'failed' || s === 'error') return colors.red(s);
  if (s === 'cancelled') return colors.yellow(s);
  if (s === 'running') return colors.cyan(s);
  return s;
}

export async function runWorkflowsExecutionsGet(
  opts: WorkflowsExecutionsGetOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'workflows executions get');
  const trace = await apiFetch<ExecutionTrace>(client, `/execution-traces/${opts.id}`);

  if (opts.json) {
    console.log(JSON.stringify(trace, null, 2));
    return;
  }
  console.log(colors.bold(`execution: ${trace.id}`));
  console.log(`  workflow:    ${trace.workflowName ?? '—'} (${trace.workflowId ?? '—'})`);
  console.log(`  status:      ${colorStatus(trace.status ?? '—')}`);
  console.log(`  startedAt:   ${trace.startedAt ?? '—'}`);
  console.log(`  completedAt: ${trace.completedAt ?? '—'}`);
  console.log(
    `  duration:    ${
      trace.durationMilliseconds !== undefined ? `${trace.durationMilliseconds}ms` : '—'
    }`,
  );
  if (trace.traceStorageUri) {
    console.log(`  storage:     ${trace.traceStorageUri}`);
  }
  if (trace.error) {
    const msg = typeof trace.error === 'string' ? trace.error : (trace.error?.message ?? '');
    if (msg) console.log(`  error:       ${colors.red(msg)}`);
  }
  const stepPaths = trace.stepPaths ?? {};
  const stepIds = Object.keys(stepPaths);
  if (stepIds.length > 0) {
    console.log('');
    console.log(colors.bold('steps:'));
    for (const id of stepIds) {
      console.log(`  ${id}  ${colors.dim(stepPaths[id])}`);
    }
  }
}
