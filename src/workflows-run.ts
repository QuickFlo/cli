/**
 * `quickflo workflows run <ref>` — fire a manual execution the same way the
 * UI's Run button does: POST /workflows/:id/execute?mode=async, which queues
 * the run via QStash onto the worker pool (worker routing, tier limits,
 * billing — identical to a UI manual run). The portal never executes the
 * workflow in-process (bd-jx13).
 *
 * Default ("sync") behavior queues then WAITS by polling the execution trace
 * until terminal. `--json` emits one final result document; `--json-stream`
 * emits typed JSONL progress. `--mode async` returns immediately after queueing.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';
import { UserError } from './errors.ts';
import {
  assertExecutionSucceeded,
  executionStreamLine,
  type ExecutionTrace,
  renderExecutionCompletion,
  tailExecution,
} from './workflows-executions-tail.ts';
import {
  buildWorkflowRunResult,
  extractReturnResponseBody,
  findSuccessfulReturnStep,
  WORKFLOW_RUN_RESULT_SCHEMA_VERSION,
} from './workflow-run-result.ts';

interface ExecuteQueuedResponse {
  status: string;
  executionId: string;
}

function readInput(opts: WorkflowsRunOptions): Record<string, unknown> {
  const sources = [
    opts.input !== undefined ? '--input' : null,
    opts.inputFile !== undefined ? '--input-file' : null,
    opts.inputStdin ? '--input-stdin' : null,
  ].filter(Boolean) as string[];
  if (sources.length > 1) {
    throw new UserError(
      `--input, --input-file, and --input-stdin are mutually exclusive (got ${
        sources.join(', ')
      }).`,
    );
  }
  let raw: string | undefined;
  if (opts.input !== undefined) raw = opts.input;
  else if (opts.inputFile !== undefined) raw = Deno.readTextFileSync(opts.inputFile);
  else if (opts.inputStdin) raw = new TextDecoder().decode(readAllSync(Deno.stdin));
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UserError(
      `Could not parse input as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserError('Input must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function readAllSync(reader: { readSync(p: Uint8Array): number | null }): Uint8Array {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  while (true) {
    const n = reader.readSync(buf);
    if (n === null || n === 0) break;
    chunks.push(buf.slice(0, n));
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Fetch step outputs for --show/--hide after the run completes.
 * `show` entries may be comma-separated; '*' expands to every recorded step.
 */
async function fetchStepOutputs(
  client: ApiClient,
  trace: ExecutionTrace,
  show: string[],
  hide: string[] | undefined,
  showSecrets: boolean | undefined,
): Promise<Record<string, unknown>> {
  const all = Object.keys(trace.stepPaths ?? {});
  const showIds = show.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const hideIds = new Set(
    (hide ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean),
  );
  const wanted = (showIds.includes('*') ? all : all.filter((id) => showIds.includes(id)))
    .filter((id) => !hideIds.has(id));
  const missing = showIds.filter((id) => id !== '*' && !all.includes(id));
  if (missing.length > 0) {
    console.error(colors.yellow(`no recorded output for step(s): ${missing.join(', ')}`));
  }
  const out: Record<string, unknown> = {};
  for (const stepId of wanted) {
    const params = new URLSearchParams();
    const stepPath = trace.stepPaths?.[stepId];
    if (stepPath) params.set('stepPath', stepPath);
    if (showSecrets) params.set('showSecrets', 'true');
    out[stepId] = await apiFetch<unknown>(
      client,
      `/execution-traces/${trace.id}/steps/${encodeURIComponent(stepId)}?${params.toString()}`,
    );
  }
  return out;
}

async function fetchReturnOutput(
  client: ApiClient,
  trace: ExecutionTrace,
  showSecrets: boolean | undefined,
): Promise<unknown> {
  const returnStep = findSuccessfulReturnStep(trace.stepStatuses, trace.stepPaths);
  if (!returnStep) {
    return undefined;
  }

  const params = new URLSearchParams({ stepPath: returnStep.stepPath });
  if (showSecrets) params.set('showSecrets', 'true');
  const stepOutput = await apiFetch<unknown>(
    client,
    `/execution-traces/${trace.id}/steps/${
      encodeURIComponent(returnStep.stepId)
    }?${params.toString()}`,
  );
  return extractReturnResponseBody(stepOutput);
}

export interface WorkflowsRunOptions {
  ref: string;
  by?: Lookup;
  input?: string;
  inputFile?: string;
  inputStdin?: boolean;
  env?: string;
  mode?: 'sync' | 'async';
  respondAs?: 'webhook' | 'execution';
  show?: string[];
  hide?: string[];
  timeout?: number;
  saveTrace?: string;
  saveStepsTo?: string;
  showSecrets?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  jsonStream?: boolean;
}

export async function runWorkflowsRun(opts: WorkflowsRunOptions): Promise<void> {
  if (opts.json && opts.jsonStream) {
    throw new UserError('--json and --json-stream are mutually exclusive.');
  }
  const { client } = await openSession(opts, 'workflows run');
  const ref = await resolveWorkflowRef(client, opts.ref, opts.by);

  const initial = readInput(opts);
  const body: { initial: Record<string, unknown>; environment?: string } = { initial };
  // Server-side precedence: body.environment overrides the workflow's stored
  // definition.environment without persisting; omit to use the stored one.
  if (opts.env !== undefined) body.environment = opts.env;

  // Always queue (explicit mode=async) — same call the UI Run button makes.
  // A workflow configured executionMode=sync must not hold this request open
  // or execute on the serving instance.
  const queued = await apiFetch<ExecuteQueuedResponse>(
    client,
    `/workflows/${ref.id}/execute?mode=async`,
    { method: 'POST', body: JSON.stringify(body) },
  );

  if (opts.mode === 'async') {
    if (opts.saveTrace || opts.saveStepsTo) {
      throw new UserError(
        '--save-trace and --save-steps-to require waiting for completion (default mode). ' +
          'Use `quickflo workflows executions tail <id> --save-trace ...` after queueing.',
      );
    }
    if (opts.jsonStream) {
      console.log(executionStreamLine({
        schemaVersion: 1,
        type: 'queued',
        executionId: queued.executionId,
        status: queued.status,
      }));
    } else if (opts.json) {
      console.log(JSON.stringify(
        {
          schemaVersion: WORKFLOW_RUN_RESULT_SCHEMA_VERSION,
          executionId: queued.executionId,
          status: queued.status,
        },
        null,
        2,
      ));
    } else {
      console.error(colors.dim(`status: ${queued.status}`));
      console.error(
        colors.dim(`Tail with: quickflo workflows executions tail ${queued.executionId}`),
      );
      console.log(queued.executionId);
    }
    return;
  }

  // The polling primitive does not own the final renderer: a finite run emits
  // one JSON result, while explicit stream mode emits one compact object/line.
  const started = Date.now();
  if (!opts.json && !opts.jsonStream) {
    console.error(colors.dim(`queued ${ref.name} → ${queued.executionId}`));
  }
  const trace = await tailExecution(client, {
    id: queued.executionId,
    timeout: opts.timeout,
    saveTrace: opts.saveTrace,
    saveStepsTo: opts.saveStepsTo,
    showSecrets: opts.showSecrets,
    renderProgress: !opts.json && !opts.jsonStream,
    onProgress: opts.jsonStream ? (event) => console.log(executionStreamLine(event)) : undefined,
  });

  const output = await fetchReturnOutput(client, trace, opts.showSecrets);
  const steps = opts.show?.length
    ? await fetchStepOutputs(client, trace, opts.show, opts.hide, opts.showSecrets)
    : undefined;
  const result = buildWorkflowRunResult(trace, output, steps);

  if (opts.jsonStream) {
    console.log(JSON.stringify({ type: 'result', ...result }));
  } else if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    renderExecutionCompletion(trace, started);
    if (output !== undefined) {
      console.log('');
      console.log(colors.bold('output:'));
      console.log(JSON.stringify(output, null, 2));
    }
    if (steps !== undefined) {
      console.log('');
      console.log(colors.bold('steps:'));
      console.log(JSON.stringify(steps, null, 2));
    }
  }

  assertExecutionSucceeded(trace, queued.executionId);
}
