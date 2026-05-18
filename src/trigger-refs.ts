/**
 * Shared trigger-ref resolution. The per-trigger verbs (`get`, `update`,
 * `delete`, `enable`, `disable`, `rotate-secret`, `duplicate`) accept a
 * `<ref>` that's either a UUID or a name. Names are unique within
 * `(organizationId, packageInstallId)` on the server, so two triggers can
 * share a name across packages — passing `-w <workflow>` disambiguates by
 * narrowing the lookup to one workflow.
 *
 * Resolution rules:
 *   - UUID → returns `{ id: <ref> }` without an API call.
 *   - Name + no workflow → GET /triggers?where[name]=<ref>. Errors if 0
 *     or >1 match, suggesting `-w <workflow>` in the latter case.
 *   - Name + workflow → GET /workflows/:wfId/triggers?where[name]=<ref>.
 *     Errors if 0 matches.
 */

import { type ApiClient, apiFetch } from './api.ts';
import { type Lookup, UUID_RE } from './refs.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';

interface TriggerRefRow {
  id: string;
  name?: string;
  workflowId?: string;
}

interface TriggerListResponse {
  data: TriggerRefRow[];
}

export interface ResolvedTriggerRef {
  /** The trigger UUID — always populated. */
  id: string;
  /** Workflow UUID if we happened to resolve via a workflow-scoped path. */
  workflowId?: string;
}

export async function resolveTriggerRef(
  client: ApiClient,
  ref: string,
  workflow?: string,
  by?: Lookup,
): Promise<ResolvedTriggerRef> {
  if (UUID_RE.test(ref)) return { id: ref };

  if (workflow) {
    const wf = await resolveWorkflowRef(client, workflow, by);
    const params = new URLSearchParams();
    params.set('where[name][$eq]', ref);
    params.set('options[limit]', '2');
    const res = await apiFetch<TriggerListResponse>(
      client,
      `/workflows/${wf.id}/triggers?${params.toString()}`,
    );
    const matches = res.data ?? [];
    if (matches.length === 0) {
      throw new Error(
        `No trigger named "${ref}" on workflow "${wf.name}".`,
      );
    }
    // Same name on the same workflow shouldn't be possible (unique index),
    // but if the server ever returns >1 we still want a clear error.
    if (matches.length > 1) {
      throw new Error(
        `Multiple triggers named "${ref}" on workflow "${wf.name}". ` +
          `Pass the trigger UUID directly.`,
      );
    }
    return { id: matches[0].id, workflowId: wf.id };
  }

  // Org-wide name lookup.
  const params = new URLSearchParams();
  params.set('where[name][$eq]', ref);
  // Limit 3 so we can detect "exactly 2" vs ">2" without scanning the whole org.
  params.set('options[limit]', '3');
  const res = await apiFetch<TriggerListResponse>(
    client,
    `/triggers?${params.toString()}`,
  );
  const matches = res.data ?? [];
  if (matches.length === 0) {
    throw new Error(`No trigger named "${ref}" in this org.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple triggers named "${ref}" in this org (likely customer-owned ` +
        `vs. package-installed copies). Pass --workflow <ref> to scope, or ` +
        `pass the trigger UUID directly. IDs: ${matches.map((t) => t.id).join(', ')}`,
    );
  }
  return { id: matches[0].id, workflowId: matches[0].workflowId };
}
