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
