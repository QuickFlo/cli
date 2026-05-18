/**
 * `quickflo workflows executions download <id>` — save the full trace JSON to
 * a local file. Default filename `trace-<id>-<YYYYMMDD-HHmm>.json`.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { defaultTraceFilename } from './trace-save.ts';

export interface WorkflowsExecutionsDownloadOptions {
  id: string;
  out?: string;
  showSecrets?: boolean;
  apiUrl?: string;
  orgId?: string;
}

export async function runWorkflowsExecutionsDownload(
  opts: WorkflowsExecutionsDownloadOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'workflows executions download');
  const params = new URLSearchParams();
  if (opts.showSecrets) params.set('showSecrets', 'true');
  const data = await apiFetch<unknown>(
    client,
    `/execution-traces/${opts.id}/trace-data?${params.toString()}`,
  );
  const path = opts.out ?? defaultTraceFilename(opts.id);
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  console.error(colors.dim(`wrote ${path}`));
}
