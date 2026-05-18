/**
 * `quickflo workflows runs download <run-id>` — save the full trace JSON to
 * a local file. Default filename `trace-<id>-<YYYYMMDD-HHmm>.json`.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';

function defaultFilename(id: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `trace-${id}-${stamp}.json`;
}

export interface WorkflowsRunsDownloadOptions {
  id: string;
  out?: string;
  showSecrets?: boolean;
  apiUrl?: string;
  orgId?: string;
}

export async function runWorkflowsRunsDownload(
  opts: WorkflowsRunsDownloadOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'workflows runs download');
  const params = new URLSearchParams();
  if (opts.showSecrets) params.set('showSecrets', 'true');
  const data = await apiFetch<unknown>(
    client,
    `/execution-traces/${opts.id}/trace-data?${params.toString()}`,
  );
  const path = opts.out ?? defaultFilename(opts.id);
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  console.error(colors.dim(`wrote ${path}`));
}
