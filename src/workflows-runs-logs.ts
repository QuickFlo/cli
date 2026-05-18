/**
 * `quickflo workflows runs logs <run-id>` — fetch one step's output, or the
 * full trace data when `--full` is set. Output is JSON to stdout for pipe
 * friendliness; `--show-secrets` passes through to the server.
 */

import { apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { UserError } from './errors.ts';

export interface WorkflowsRunsLogsOptions {
  id: string;
  step?: string;
  stepPath?: string;
  full?: boolean;
  showSecrets?: boolean;
  apiUrl?: string;
  orgId?: string;
}

export async function runWorkflowsRunsLogs(opts: WorkflowsRunsLogsOptions): Promise<void> {
  const { client } = await openSession(opts, 'workflows runs logs');

  if (opts.full) {
    const params = new URLSearchParams();
    if (opts.showSecrets) params.set('showSecrets', 'true');
    const data = await apiFetch<unknown>(
      client,
      `/execution-traces/${opts.id}/trace-data?${params.toString()}`,
    );
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!opts.step) {
    throw new UserError('Pass --step <step-id> or --full to fetch the entire trace.');
  }

  const params = new URLSearchParams();
  if (opts.stepPath) params.set('stepPath', opts.stepPath);
  if (opts.showSecrets) params.set('showSecrets', 'true');
  const out = await apiFetch<unknown>(
    client,
    `/execution-traces/${opts.id}/steps/${encodeURIComponent(opts.step)}?${params.toString()}`,
  );
  console.log(JSON.stringify(out, null, 2));
}
