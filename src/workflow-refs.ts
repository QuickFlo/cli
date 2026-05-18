/**
 * Shared workflow-ref resolution. Commands that scope by workflow (triggers,
 * future per-workflow surfaces) take a `<workflow>` arg that may be a UUID,
 * SUID, or name — same grammar as `workflows get`. This module turns that
 * string into a `{ id, name }` pair so downstream API calls have a stable
 * workflow id to plug into `/workflows/:wfId/…` paths.
 */

import { type ApiClient, apiFetch } from './api.ts';
import { detectLookup, type Lookup } from './refs.ts';

export interface WorkflowRef {
  id: string;
  suid?: string;
  name: string;
}

interface WorkflowListResponse {
  data: WorkflowRef[];
}

export async function resolveWorkflowRef(
  client: ApiClient,
  ref: string,
  by?: Lookup,
): Promise<WorkflowRef> {
  const lookup = by ?? detectLookup(ref);
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set(`where[${lookup}][$eq]`, ref);
  params.set('options[limit]', '1');
  const res = await apiFetch<WorkflowListResponse>(
    client,
    `/workflows?${params.toString()}`,
  );
  const match = res.data?.[0];
  if (!match) {
    throw new Error(`No workflow found where ${lookup}="${ref}".`);
  }
  return match;
}

/**
 * Batch-resolve workflow IDs → names in a single round trip. Used by list
 * commands that show child rows (triggers, executions) so the WORKFLOW
 * column reads as a name instead of a UUID. IDs that don't resolve are
 * simply absent from the result — callers fall back to the raw id.
 */
export async function resolveWorkflowNames(
  client: ApiClient,
  workflowIds: Iterable<string>,
): Promise<Map<string, string>> {
  const ids = [...new Set(workflowIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  // Mirror the qs-parser dance from resolveInstallAddresses — single id
  // uses $eq, multiple use the `[]`-suffixed $in array form.
  if (ids.length === 1) {
    params.set('where[id][$eq]', ids[0]);
  } else {
    for (const id of ids) params.append('where[id][$in][]', id);
  }
  params.set('options[limit]', String(ids.length));

  const res = await apiFetch<WorkflowListResponse>(
    client,
    `/workflows?${params.toString()}`,
  );
  for (const wf of res.data ?? []) {
    out.set(wf.id, wf.name);
  }
  return out;
}
