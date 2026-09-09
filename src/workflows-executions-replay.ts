/**
 * `quickflo workflows executions replay <id>` — ask the server to queue an
 * exact rerun of a terminal execution, then either return the new execution ID
 * or wait for it using the same completion path as `workflows run`.
 *
 * The server owns source authorization and recovery of the pinned trigger
 * input. The CLI deliberately does not download or interpret trace data.
 */

import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { completeQueuedWorkflowRun, type QueuedWorkflowRunResponse } from './workflows-run.ts';

export interface WorkflowsExecutionsReplayOptions {
  id: string;
  mode?: 'sync' | 'async';
  timeout?: number;
  show?: string[];
  hide?: string[];
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export function queueExecutionReplay(
  client: ApiClient,
  sourceExecutionId: string,
): Promise<QueuedWorkflowRunResponse> {
  return apiFetch<QueuedWorkflowRunResponse>(
    client,
    `/workflows/rerun/${encodeURIComponent(sourceExecutionId)}`,
    { method: 'POST' },
  );
}

export async function runWorkflowsExecutionsReplay(
  opts: WorkflowsExecutionsReplayOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'workflows executions replay');
  const queued = await queueExecutionReplay(client, opts.id);
  await completeQueuedWorkflowRun(client, queued, {
    mode: opts.mode,
    timeout: opts.timeout,
    show: opts.show,
    hide: opts.hide,
    json: opts.json,
    label: `replay of ${opts.id}`,
  });
}
