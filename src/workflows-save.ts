/**
 * Shared workflow create/update (upsert) helpers, extracted from
 * `workflows-push.ts` so both `push` and the MCP server's
 * `save_workflow_draft` tool reuse ONE persistence path. Pure payload building
 * plus the POST/PATCH calls — NO triggers, NO logging, NO stdout writes (safe
 * to call from the MCP stdio server, where stdout is reserved for JSON-RPC).
 */

import { type ApiClient, apiFetch } from './api.ts';

/**
 * Loose shape: only the fields the CLI itself reads are typed; everything else
 * passes through to the server, whose Zod (createWorkflowTemplateSchema /
 * updateWorkflowTemplateSchema) is the validation source of truth.
 */
export interface WorkflowDefinition {
  id?: string;
  name: string;
  // `steps` lives at the top level in CLI files (push wraps it into
  // `definition.steps` server-side).
  steps: unknown[];
  // description, isTemplate, isPublic, tags, parameters, uiMetadata,
  // environment, initial, options, agentToolMetadata, etc. pass through.
  [key: string]: unknown;
}

export interface ExistingWorkflow {
  id: string;
  name: string;
  packageInstallId?: string | null;
}

/**
 * Top-level fields the server fully owns — mutating them client-side is either
 * rejected (organizationId), auto-derived (usedActionTypes), or audit-only
 * (createdAt, updatedAt, userId; packageInstallId — installer-only).
 */
const SERVER_MANAGED_FIELDS = new Set([
  'organizationId',
  'packageInstallId',
  'createdAt',
  'updatedAt',
  'userId',
  'usedActionTypes',
]);

/**
 * Top-level fields that belong INSIDE `definition` server-side. The CLI file
 * shape flattens them for ergonomics, so the payload nests them back.
 * `options` carries executionMode, stopOnError, timeoutMilliseconds, workerTier.
 */
const DEFINITION_FIELDS = new Set(['environment', 'initial', 'steps', 'options']);

export function buildDefinition(def: WorkflowDefinition): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    steps: def['steps'] ?? [],
  };
  if (def['initial'] !== undefined) definition['initial'] = def['initial'];
  if (def['environment']) definition['environment'] = def['environment'];
  if (def['options'] !== undefined) definition['options'] = def['options'];
  return definition;
}

/**
 * Builds the top-level POST/PATCH payload via denylist passthrough: server-
 * managed fields stripped, `definition` rebuilt from flattened
 * steps/initial/environment/options, everything else flows through. The
 * server's Zod validates and rejects unknown fields (bd-y8tr).
 */
export function buildWorkflowPayload(
  def: WorkflowDefinition,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: def.name,
    definition: buildDefinition(def),
  };
  for (const [key, value] of Object.entries(def)) {
    if (SERVER_MANAGED_FIELDS.has(key)) continue;
    if (DEFINITION_FIELDS.has(key)) continue; // handled by buildDefinition
    if (key === 'name' || key === 'id' || key === 'definition') continue;
    if (value === undefined) continue;
    body[key] = value;
  }
  return body;
}

/**
 * Lookup restricted to org-owned (packageInstallId IS NULL) rows so we never
 * silently PATCH a package-managed row that shares a name. The installer is
 * the only legitimate writer of package rows.
 */
export async function findWorkflowByName(
  client: ApiClient,
  name: string,
): Promise<ExistingWorkflow | null> {
  const params = new URLSearchParams();
  params.set('where[name][$eq]', name);
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[packageInstallId]', 'null');
  params.set('options[limit]', '1');
  const res = await apiFetch<{ data: ExistingWorkflow[]; total: number }>(
    client,
    `/workflows?${params.toString()}`,
  );
  return res.data?.[0] || null;
}

/**
 * If a pinned id belongs to a package-installed workflow, fail loudly rather
 * than PATCHing it.
 */
export async function findWorkflowById(
  client: ApiClient,
  id: string,
): Promise<ExistingWorkflow | null> {
  let row: ExistingWorkflow;
  try {
    row = await apiFetch<ExistingWorkflow>(client, `/workflows/${id}`);
  } catch {
    return null;
  }
  if (row.packageInstallId) {
    throw new Error(
      `workflow id ${id} belongs to a package-installed workflow (packageInstallId=${row.packageInstallId}); remove the "id" field to save as a new customer-owned workflow`,
    );
  }
  return row;
}

export function createWorkflow(
  client: ApiClient,
  def: WorkflowDefinition,
): Promise<ExistingWorkflow> {
  const body: Record<string, unknown> = {
    ...buildWorkflowPayload(def),
    organizationId: client.orgId,
  };
  if (def.id) body['id'] = def.id;
  if (body['isTemplate'] === undefined) body['isTemplate'] = false;
  if (body['isPublic'] === undefined) body['isPublic'] = false;
  return apiFetch<ExistingWorkflow>(client, `/workflows`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateWorkflow(
  client: ApiClient,
  id: string,
  def: WorkflowDefinition,
): Promise<ExistingWorkflow> {
  return apiFetch<ExistingWorkflow>(client, `/workflows/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(buildWorkflowPayload(def)),
  });
}

/**
 * Find-or-upsert a single org-owned workflow. No triggers, no execution, no
 * stdout. Prefers id lookup (stable across renames), falls back to name.
 * Returns the saved row plus whether it was created or updated. The server
 * runs full validation on save and rejects on errors (the caller surfaces the
 * resulting ApiError message).
 */
export async function saveWorkflow(
  client: ApiClient,
  def: WorkflowDefinition,
): Promise<{ workflow: ExistingWorkflow; action: 'created' | 'updated' }> {
  const existing = def.id
    ? await findWorkflowById(client, def.id)
    : await findWorkflowByName(client, def.name);
  if (existing) {
    const workflow = await updateWorkflow(client, existing.id, def);
    return { workflow, action: 'updated' };
  }
  const workflow = await createWorkflow(client, def);
  return { workflow, action: 'created' };
}
