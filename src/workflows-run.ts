/**
 * `quickflo workflows run <ref>` — fire a manual execution against
 * /workflows/execute. The CLI fetches the workflow's stored definition,
 * merges in the user-supplied `initial` + `--env` override, and POSTs.
 *
 * Sync mode prints a per-step table to stdout (with the result JSON
 * underneath); async mode prints the executionId so a follow-up
 * `quickflo workflows runs get <id>` can tail progress.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { openSession } from './session.ts';
import { TimeoutError, UserError, ValidationError } from './errors.ts';

interface WorkflowRecord {
  id: string;
  suid?: string;
  name: string;
  definition?: {
    steps?: unknown[];
    initial?: Record<string, unknown>;
    environment?: string;
  };
}

interface WorkflowListResponse {
  data: WorkflowRecord[];
}

interface ExecuteRequestBody {
  name: string;
  initial: Record<string, unknown>;
  steps: unknown[];
  environment?: string;
}

interface ExecuteStepResult {
  stepId?: string;
  status?: string;
  durationMilliseconds?: number;
  error?: { message?: string } | string;
}

interface ExecuteSyncResponse {
  success: boolean;
  executionId?: string;
  output?: unknown;
  error?: { message?: string } | string;
  metadata?: { stepResults?: ExecuteStepResult[]; durationMilliseconds?: number };
  metrics?: { durationMilliseconds?: number };
}

interface ExecuteAsyncResponse {
  status: string;
  executionId: string;
}

async function fetchWorkflow(client: ApiClient, id: string): Promise<WorkflowRecord> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[id][$eq]', id);
  params.set('options[limit]', '1');
  const res = await apiFetch<WorkflowListResponse>(client, `/workflows?${params.toString()}`);
  const wf = res.data?.[0];
  if (!wf) throw new UserError(`Workflow ${id} not found in this organization.`);
  return wf;
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function colorStatus(s: string): string {
  if (s === 'success') return colors.green(s);
  if (s === 'failed' || s === 'error') return colors.red(s);
  if (s === 'cancelled') return colors.yellow(s);
  if (s === 'running') return colors.cyan(s);
  return s;
}

function printSync(name: string, res: ExecuteSyncResponse): void {
  const duration = res.metrics?.durationMilliseconds ?? res.metadata?.durationMilliseconds;
  console.log(colors.bold(`run: ${name}`));
  console.log(`  success:     ${res.success ? colors.green('true') : colors.red('false')}`);
  console.log(`  executionId: ${res.executionId ?? '—'}`);
  console.log(`  duration:    ${duration !== undefined ? `${duration}ms` : '—'}`);
  const steps = res.metadata?.stepResults ?? [];
  if (steps.length > 0) {
    const idWidth = Math.min(40, Math.max(4, ...steps.map((s) => (s.stepId ?? '—').length)));
    const statusWidth = Math.min(10, Math.max(6, ...steps.map((s) => (s.status ?? '—').length)));
    const header = [
      'STEP'.padEnd(idWidth),
      'STATUS'.padEnd(statusWidth),
      'TIME'.padStart(7),
      'ERROR',
    ].join('  ');
    console.log('');
    console.log(colors.bold(header));
    console.log(colors.dim('─'.repeat(header.length)));
    for (const s of steps) {
      const err = typeof s.error === 'string' ? s.error : (s.error?.message ?? '');
      console.log([
        truncate(s.stepId ?? '—', idWidth).padEnd(idWidth),
        colorStatus(s.status ?? '—').padEnd(statusWidth + 10), // padEnd doesn't account for ANSI, but visually close
        s.durationMilliseconds !== undefined
          ? `${s.durationMilliseconds}ms`.padStart(7)
          : '—'.padStart(7),
        truncate(err, 60),
      ].join('  '));
    }
  }
  if (!res.success) {
    const msg = typeof res.error === 'string' ? res.error : (res.error?.message ?? 'unknown');
    console.error(colors.red(`\nerror: ${msg}`));
  }
}

export interface WorkflowsRunOptions {
  ref: string;
  by?: Lookup;
  input?: string;
  inputFile?: string;
  inputStdin?: boolean;
  env?: string;
  mode?: 'sync' | 'async';
  show?: string[];
  hide?: string[];
  timeout?: number;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsRun(opts: WorkflowsRunOptions): Promise<void> {
  const { client } = await openSession(opts, 'workflows run');
  const ref = await resolveWorkflowRef(client, opts.ref, opts.by);
  const wf = await fetchWorkflow(client, ref.id);

  const initial = readInput(opts);
  const body: ExecuteRequestBody = {
    name: wf.name,
    initial: { ...(wf.definition?.initial ?? {}), ...initial },
    steps: wf.definition?.steps ?? [],
  };
  if (opts.env !== undefined) body.environment = opts.env;
  else if (wf.definition?.environment) body.environment = wf.definition.environment;

  const mode = opts.mode ?? 'sync';
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (opts.show?.length) params.set('show', opts.show.join(','));
  if (opts.hide?.length) params.set('hide', opts.hide.join(','));

  const controller = new AbortController();
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : undefined;
  let timer: number | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  let response: ExecuteSyncResponse | ExecuteAsyncResponse;
  try {
    response = await apiFetch<ExecuteSyncResponse | ExecuteAsyncResponse>(
      client,
      `/workflows/execute?${params.toString()}`,
      { method: 'POST', body: JSON.stringify(body), signal: controller.signal },
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new TimeoutError(`Workflow execution exceeded --timeout=${opts.timeout}s.`);
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (mode === 'async') {
    const r = response as ExecuteAsyncResponse;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.error(colors.dim(`status: ${r.status}`));
      console.error(colors.dim(`Tail with: quickflo workflows runs get ${r.executionId}`));
      console.log(r.executionId);
    }
    return;
  }

  const r = response as ExecuteSyncResponse;
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    printSync(wf.name, r);
    if (r.output !== undefined) {
      console.log('');
      console.log(colors.bold('output:'));
      console.log(JSON.stringify(r.output, null, 2));
    }
  }
  if (!r.success) {
    const msg = typeof r.error === 'string'
      ? r.error
      : (r.error?.message ?? 'workflow execution failed');
    throw new ValidationError(msg, { code: 'workflow_failed', details: r });
  }
}
