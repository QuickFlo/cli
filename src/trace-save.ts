/**
 * Shared helpers for persisting an execution's trace to disk. Used by
 * `workflows run --save-trace / --save-steps-to`,
 * `workflows executions download`, and `workflows executions tail`.
 */

import { dirname, join } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';

export function defaultTraceFilename(id: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `trace-${id}-${stamp}.json`;
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

export async function fetchTraceData(
  client: ApiClient,
  id: string,
  showSecrets: boolean | undefined,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (showSecrets) params.set('showSecrets', 'true');
  return await apiFetch<unknown>(
    client,
    `/execution-traces/${id}/trace-data?${params.toString()}`,
  );
}

export async function saveTrace(
  client: ApiClient,
  id: string,
  path: string,
  showSecrets: boolean | undefined,
): Promise<string> {
  const data = await fetchTraceData(client, id, showSecrets);
  const dir = dirname(path);
  if (dir && dir !== '.' && dir !== '') await ensureDir(dir);
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  return path;
}

interface ExecutionTraceWithSteps {
  stepPaths?: Record<string, string>;
}

/**
 * Fan out per-step output to one file per step under <dir>. Each file is
 * named `<safe-step-id>.json`. Returns the list of written paths.
 *
 * Uses GET /execution-traces/:id/steps/:stepId for each step. The server
 * returns whatever shape it persists per step path; we write it verbatim.
 */
export async function saveSteps(
  client: ApiClient,
  id: string,
  dir: string,
  showSecrets: boolean | undefined,
): Promise<string[]> {
  const trace = await apiFetch<ExecutionTraceWithSteps>(client, `/execution-traces/${id}`);
  const stepPaths = trace.stepPaths ?? {};
  const stepIds = Object.keys(stepPaths);
  if (stepIds.length === 0) return [];
  await ensureDir(dir);
  const written: string[] = [];
  for (const stepId of stepIds) {
    const params = new URLSearchParams();
    if (showSecrets) params.set('showSecrets', 'true');
    const out = await apiFetch<unknown>(
      client,
      `/execution-traces/${id}/steps/${encodeURIComponent(stepId)}?${params.toString()}`,
    );
    const safeId = stepId.replace(/[^A-Za-z0-9._-]+/g, '_');
    const target = join(dir, `${safeId}.json`);
    await Deno.writeTextFile(target, JSON.stringify(out, null, 2));
    written.push(target);
  }
  return written;
}
