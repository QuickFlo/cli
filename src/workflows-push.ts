/**
 * `quickflo workflows push` command — bulk-upserts workflow JSON files from a
 * directory into an organization, and optionally creates webhook triggers.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';
import {
  DuplicateKeyError,
  extractSubWorkflowRefs,
  type PushFileNode,
  topoSortFiles,
} from './workflow-deps.ts';

/**
 * Loose shape: only the fields the CLI itself reads (for topo-sort,
 * filename, control flow) are typed strictly. Everything else passes
 * through to the server — the server's Zod (createWorkflowTemplate-
 * Schema / updateWorkflowTemplateSchema) is the validation source of
 * truth and rejects anything it doesn't recognize. Avoids the silent-
 * drop class of bug that an allowlist invites; a new server field
 * doesn't need a CLI patch to round-trip.
 */
interface WorkflowDefinition {
  id?: string;
  name: string;
  // `steps` lives at the top level in CLI files (push wraps it into
  // `definition.steps` server-side); read here for topo-sort.
  steps: unknown[];
  // Everything else — description, isTemplate, isPublic, tags,
  // parameters, uiMetadata, environment, initial, agentToolMetadata,
  // and anything the server adds later — passes through to the
  // payload via the denylist-based builder below.
  [key: string]: unknown;
}

interface ExistingWorkflow {
  id: string;
  name: string;
  packageInstallId?: string | null;
}

interface ExistingTrigger {
  id: string;
  type: string;
  name?: string;
  webhookUrl?: string;
  config?: { webhook?: { secret?: string } };
}

interface CreatedTrigger {
  id: string;
  webhookUrl: string;
  config?: { webhook?: { secret?: string } };
}

interface PushResult {
  filename: string;
  workflowName: string;
  workflowId: string;
  action: 'created' | 'updated' | 'skipped';
  triggerAction: 'created' | 'existing' | 'regenerated' | 'failed' | 'skipped';
  webhookUrl?: string;
  secret?: string;
}

/**
 * Lookup is restricted to org-owned (packageInstallId IS NULL) rows.
 * A customer-owned and a package-managed row are allowed to share a name
 * in the same org — the unique index is (organizationId, packageInstallId,
 * name) with NULLS NOT DISTINCT (workflow-template.model.ts). Without this
 * filter, push would silently PATCH a package-managed row when names
 * collide. The installer is the only legitimate writer of package rows.
 */
async function findWorkflowByName(
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
 * If a file pins an id that belongs to a package-installed workflow, fail
 * loudly rather than PATCHing it. Pull never writes package-row ids into
 * customer files, so this only triggers on intentional copy-paste — and
 * silently mutating a package-managed row is exactly what we're trying
 * to prevent.
 */
async function findWorkflowById(
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
      `workflow id ${id} belongs to a package-installed workflow (packageInstallId=${row.packageInstallId}); remove the "id" field from the file to push as a new customer-owned workflow`,
    );
  }
  return row;
}

/**
 * Top-level fields the server fully owns — mutating them client-side is
 * either rejected (RBAC: organizationId), silently overwritten on save
 * (auto-derived: usedActionTypes), or meaningless to the engine (audit:
 * createdAt, updatedAt, userId; lifecycle: packageInstallId — the
 * installer is the only legitimate writer of that field, customer-side
 * pushes go to customer-owned rows).
 *
 * Note on `id`: not in this set. `id` is server-owned BUT clients are
 * permitted to pin one on create as a stable handle, and pull writes
 * it into the file so a subsequent push finds the same row by id even
 * after a rename. The duplicate-id check in `runWorkflowsPush` catches
 * the copy-and-rename footgun where a user forgets to drop the id.
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
 * Top-level fields that belong INSIDE `definition` server-side. The CLI
 * file shape flattens them for ergonomics (`environment`, `initial`,
 * `steps` live at the top level when authored), so the push payload
 * needs to nest them back.
 */
const DEFINITION_FIELDS = new Set(['environment', 'initial', 'steps']);

// The `environment` field lives INSIDE `definition`, not at the top level —
// see workflow-template.service.ts: `template.definition.environment`.
function buildDefinition(def: WorkflowDefinition): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    steps: def['steps'] ?? [],
  };
  if (def['initial'] !== undefined) definition['initial'] = def['initial'];
  if (def['environment']) definition['environment'] = def['environment'];
  return definition;
}

// Builds the top-level payload for POST/PATCH via denylist passthrough.
// Server-managed fields are stripped; `definition` is rebuilt from the
// flattened steps/initial/environment; everything else (including
// fields the CLI doesn't explicitly know about) flows through. The
// server's Zod validates and rejects unknown fields — silent CLI
// drops are not a failure mode we tolerate here (bd-y8tr).
function buildWorkflowPayload(
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

function createWorkflow(
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

function updateWorkflow(
  client: ApiClient,
  id: string,
  def: WorkflowDefinition,
): Promise<ExistingWorkflow> {
  return apiFetch<ExistingWorkflow>(client, `/workflows/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(buildWorkflowPayload(def)),
  });
}

async function listTriggers(
  client: ApiClient,
  workflowId: string,
): Promise<ExistingTrigger[]> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  const res = await apiFetch<ExistingTrigger[] | { data: ExistingTrigger[] }>(
    client,
    `/workflows/${workflowId}/triggers?${params.toString()}`,
  );
  return Array.isArray(res) ? res : res.data || [];
}

function createWebhookTrigger(
  client: ApiClient,
  workflowId: string,
  triggerName: string,
): Promise<CreatedTrigger> {
  const body = {
    type: 'webhook',
    name: triggerName,
    organizationId: client.orgId,
    config: {
      webhook: {
        method: 'POST',
        authType: 'token',
        timeout: 120000,
        exposeErrors: true,
      },
    },
  };
  return apiFetch<CreatedTrigger>(client, `/workflows/${workflowId}/triggers`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function regenerateSecret(
  client: ApiClient,
  workflowId: string,
  triggerId: string,
): Promise<CreatedTrigger> {
  return apiFetch<CreatedTrigger>(
    client,
    `/workflows/${workflowId}/triggers/${triggerId}/regenerate-secret`,
    { method: 'POST' },
  );
}

async function pushWorkflowFile(
  client: ApiClient,
  filename: string,
  def: WorkflowDefinition,
  opts: { dryRun: boolean; createTriggers: boolean; regenerateSecrets: boolean },
): Promise<PushResult> {
  console.error(
    `\n${colors.bold(`[${filename}]`)} → ${colors.cyan(def.name)}`,
  );

  if (opts.dryRun) {
    const triggerNote = opts.createTriggers
      ? ' + webhook trigger'
      : ' (workflow only — pass -t to also create webhook)';
    console.error(
      `  ${colors.dim(`(dry-run) would create/update workflow${triggerNote}`)}`,
    );
    return {
      filename,
      workflowName: def.name,
      workflowId: 'dry-run',
      action: 'skipped',
      triggerAction: 'skipped',
    };
  }

  // Prefer lookup by id (stable across renames); fall back to name match.
  const existing = def.id
    ? await findWorkflowById(client, def.id)
    : await findWorkflowByName(client, def.name);
  let wf: ExistingWorkflow;
  let action: PushResult['action'];
  if (existing) {
    wf = await updateWorkflow(client, existing.id, def);
    action = 'updated';
    console.error(
      `  ${colors.green('✓')} updated workflow ${colors.dim(wf.id)}`,
    );
  } else {
    wf = await createWorkflow(client, def);
    action = 'created';
    console.error(
      `  ${colors.green('✓')} created workflow ${colors.dim(wf.id)}`,
    );
  }

  let triggerAction: PushResult['triggerAction'] = 'skipped';
  let webhookUrl: string | undefined;
  let secret: string | undefined;

  if (!opts.createTriggers) {
    return {
      filename,
      workflowName: def.name,
      workflowId: wf.id,
      action,
      triggerAction,
    };
  }

  const triggers = await listTriggers(client, wf.id);
  const webhookTrigger = triggers.find((t) => t.type === 'webhook');

  if (webhookTrigger) {
    webhookUrl = webhookTrigger.webhookUrl;
    secret = webhookTrigger.config?.webhook?.secret;
    if (opts.regenerateSecrets) {
      try {
        const regen = await regenerateSecret(client, wf.id, webhookTrigger.id);
        secret = regen.config?.webhook?.secret;
        triggerAction = 'regenerated';
        console.error(`  ${colors.green('✓')} regenerated trigger secret`);
      } catch (e) {
        triggerAction = 'failed';
        console.error(
          `  ${colors.red('✗')} failed to regenerate secret: ${(e as Error).message}`,
        );
      }
    } else {
      triggerAction = 'existing';
      console.error(
        `  ${colors.dim('•')} webhook trigger already exists (using stored secret)`,
      );
    }
  } else {
    try {
      const created = await createWebhookTrigger(client, wf.id, def.name);
      webhookUrl = created.webhookUrl;
      secret = created.config?.webhook?.secret;
      triggerAction = 'created';
      console.error(`  ${colors.green('✓')} created webhook trigger`);
    } catch (e) {
      triggerAction = 'failed';
      console.error(
        `  ${colors.red('✗')} failed to create trigger: ${(e as Error).message}`,
      );
    }
  }

  return {
    filename,
    workflowName: def.name,
    workflowId: wf.id,
    action,
    triggerAction,
    webhookUrl,
    secret,
  };
}

// Stdout: user-capturable payload (URL + secret per trigger).
function printTriggerOutputs(results: PushResult[]): void {
  const usable = results.filter((r) => r.webhookUrl);
  if (usable.length === 0) return;
  console.log('');
  for (const r of usable) {
    console.log(r.webhookUrl);
    console.log(r.secret ?? '(secret not available)');
    console.log('');
  }
}

function printSummary(results: PushResult[], createTriggers: boolean): void {
  console.error('\n' + colors.bold('Summary'));
  const created = results.filter((r) => r.action === 'created').length;
  const updated = results.filter((r) => r.action === 'updated').length;
  console.error(
    `  Workflows: ${colors.green(`${created} created`)}, ${colors.yellow(`${updated} updated`)}`,
  );
  if (!createTriggers) {
    console.error(
      `  Triggers:  ${colors.dim('skipped (pass -t to create them)')}`,
    );
    return;
  }
  const c = results.filter((r) => r.triggerAction === 'created').length;
  const e = results.filter((r) => r.triggerAction === 'existing').length;
  const r = results.filter((r) => r.triggerAction === 'regenerated').length;
  const f = results.filter((r) => r.triggerAction === 'failed').length;
  console.error(
    `  Triggers:  ${colors.green(`${c} created`)}, ${e} existing, ${r} regenerated, ${
      f > 0 ? colors.red(`${f} failed`) : `${f} failed`
    }`,
  );
}

export interface WorkflowsPushOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  username?: string;
  password?: string;
  dryRun: boolean;
  createTriggers: boolean;
  regenerateSecrets: boolean;
  noCache?: boolean;
}

export async function runWorkflowsPush(
  opts: WorkflowsPushOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'push');
  const dir = resolve(opts.dir);
  console.error(`  Dir:  ${dir}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );

  let dirInfo;
  try {
    dirInfo = await Deno.stat(dir);
  } catch {
    console.error(colors.red(`\nError: directory not found: ${dir}`));
    Deno.exit(1);
  }
  if (!dirInfo.isDirectory) {
    console.error(colors.red(`\nError: not a directory: ${dir}`));
    Deno.exit(1);
  }

  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith('.json')) {
      files.push(`${dir}/${entry.name}`);
    }
  }
  files.sort();

  if (files.length === 0) {
    console.error(colors.red(`\nError: no .json files found in ${dir}`));
    Deno.exit(1);
  }

  console.error(
    `\nFound ${colors.bold(String(files.length))} workflow file(s) to push`,
  );

  // Parse every file up-front so we can topo-sort by sub-workflow deps
  // and fail fast on cycles / duplicate keys before any network call.
  const nodes: PushFileNode[] = [];
  const parseErrors: Array<{ filename: string; error: Error }> = [];
  for (const filePath of files) {
    const filename = filePath.split('/').pop() || filePath;
    try {
      const raw = await Deno.readTextFile(filePath);
      const def = JSON.parse(raw) as WorkflowDefinition;
      if (!def.name) {
        throw new Error(`missing 'name' field`);
      }
      nodes.push({
        filename: filePath,
        def: { id: def.id, name: def.name, steps: def.steps },
        refs: extractSubWorkflowRefs({ steps: def.steps }),
      });
    } catch (e) {
      parseErrors.push({ filename, error: e as Error });
    }
  }
  for (const { filename, error } of parseErrors) {
    console.error(`  ${colors.red('✗')} ${filename}: ${error.message}`);
  }

  let ordered: PushFileNode[];
  let unresolved: ReturnType<typeof topoSortFiles>['unresolved'];
  let cycles: string[][];
  try {
    const sorted = topoSortFiles(nodes);
    ordered = sorted.order;
    unresolved = sorted.unresolved;
    cycles = sorted.cycles;
  } catch (e) {
    if (e instanceof DuplicateKeyError) {
      console.error(
        colors.red(
          `\nError: duplicate workflow ${e.kind} "${e.value}" across files: ${e.files.join(', ')}`,
        ),
      );
      Deno.exit(1);
    }
    throw e;
  }

  if (cycles.length > 0) {
    console.error(
      `\n${
        colors.yellow('!')
      } sub-workflow dependency cycle(s) detected — upload will proceed in alpha order for cycle members. Runtime depth guard will catch infinite recursion.`,
    );
    for (const cycle of cycles) {
      const names = cycle.map((f) => f.split('/').pop() || f);
      console.error(`  ${names.join(' → ')}`);
    }
  }

  // Warn about dynamic refs (liquid-templated sub-workflow names/ids) —
  // we can't statically verify these, surface them so the user knows.
  const dynamicWarnings = ordered.flatMap((n) =>
    n.refs.dynamic.map((d) => ({
      filename: n.filename.split('/').pop() || n.filename,
      ...d,
    }))
  );
  if (dynamicWarnings.length > 0) {
    console.error(
      `\n${
        colors.yellow('!')
      } ${dynamicWarnings.length} dynamic sub-workflow ref(s) — not statically checked:`,
    );
    for (const w of dynamicWarnings) {
      console.error(
        `  ${colors.dim(`[${w.filename}]`)} ${w.stepPath} ${w.kind}=${w.value}`,
      );
    }
  }

  if (unresolved.length > 0) {
    console.error(
      `\n${
        colors.dim('•')
      } ${unresolved.length} external sub-workflow ref(s) (assumed present in target org):`,
    );
    for (const u of unresolved) {
      const fname = u.filename.split('/').pop() || u.filename;
      console.error(`  ${colors.dim(`[${fname}]`)} ${u.kind}=${u.value}`);
    }
  }

  // Print the computed upload order so users can sanity-check.
  const reordered = ordered.some((n, i) => n.filename !== files[i]);
  if (reordered) {
    console.error(`\n${colors.bold('Upload order')} (topo-sorted by deps):`);
    for (const n of ordered) {
      const fname = n.filename.split('/').pop() || n.filename;
      console.error(`  ${fname}`);
    }
  }

  const results: PushResult[] = [];
  for (const node of ordered) {
    const filename = node.filename.split('/').pop() || node.filename;
    try {
      const raw = await Deno.readTextFile(node.filename);
      const def = JSON.parse(raw) as WorkflowDefinition;
      results.push(
        await pushWorkflowFile(client, filename, def, {
          dryRun: opts.dryRun,
          createTriggers: opts.createTriggers,
          regenerateSecrets: opts.regenerateSecrets,
        }),
      );
    } catch (e) {
      console.error(`  ${colors.red('✗')} ${(e as Error).message}`);
    }
  }

  printSummary(results, opts.createTriggers);
  if (!opts.dryRun && opts.createTriggers) {
    printTriggerOutputs(results);
  }
}
