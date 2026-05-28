/**
 * `quickflo triggers push` command — bulk-upserts trigger JSON files from a
 * directory into an organization, re-associating each trigger with its parent
 * workflow by *name* (the `"workflow"` field written by `triggers pull`).
 *
 * Association is name-based so trigger files are portable across orgs: the
 * workflow name is resolved to an org-owned workflow id at push time. Triggers
 * are matched for upsert by `(workflowId, name)` — trigger names are globally
 * unique per org — so re-pushing updates in place. Secrets never round-trip:
 * a new webhook secret is minted server-side on create, and an existing
 * trigger's secret is left untouched on update.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import {
  collectFormCredentialNames,
  collectFormWorkflowNames,
  formRefsToIds,
} from './trigger-form-refs.ts';
import { openSession } from './session.ts';

/**
 * Loose shape: only the fields the CLI reads for control flow are typed;
 * everything else passes through to the server, whose Zod validates and
 * rejects unknown fields (same denylist philosophy as workflows-push).
 */
export interface TriggerFile {
  /** Preserved from pull for same-org rename-stable matching; not sent on create. */
  id?: string;
  /** Parent workflow, by name. Required — this is the association. */
  workflow: string;
  type: string;
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
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
  packageInstallId?: string | null;
}

interface CreatedTrigger {
  id: string;
  webhookUrl?: string;
  formUrl?: string;
  config?: { webhook?: { secret?: string } };
}

interface PushResult {
  filename: string;
  triggerName: string;
  workflowName: string;
  action: 'created' | 'updated' | 'skipped' | 'failed';
  url?: string;
  secret?: string;
  error?: string;
}

/**
 * Resolve a workflow name → org-owned workflow. Scoped to packageInstallId IS
 * NULL so triggers map to the user's own workflows, never a package's shadow
 * copy (packages can carry duplicate workflow names). Fails loudly on both
 * "not found" (the association is meaningless without a workflow) and ">1
 * match" (ambiguous — we refuse to guess which org-owned workflow is meant).
 */
async function resolveWorkflowByName(
  client: ApiClient,
  name: string,
): Promise<ExistingWorkflow> {
  const params = new URLSearchParams();
  params.set('where[name][$eq]', name);
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[packageInstallId]', 'null');
  params.set('options[limit]', '2'); // 2 so we can detect ambiguity
  const res = await apiFetch<{ data: ExistingWorkflow[]; total: number }>(
    client,
    `/workflows?${params.toString()}`,
  );
  const matches = res.data ?? [];
  if (matches.length === 0) {
    throw new Error(
      `no org-owned workflow named "${name}" — push the workflow before its triggers`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `workflow name "${name}" is ambiguous — ${matches.length}+ org-owned workflows share it (ids: ${
        matches.map((m) => m.id).join(', ')
      }); rename or disambiguate before pushing triggers`,
    );
  }
  return matches[0];
}

/**
 * Soft variant for form workflow refs (prefill / confirmation / chat). Returns
 * the org-owned workflow id, or null when the name resolves to 0 or >1 — these
 * refs are best-effort, so the caller drops the ref rather than failing the
 * whole push (unlike the trigger's primary `workflow`, which is hard-required).
 */
async function resolveWorkflowByNameSoft(
  client: ApiClient,
  name: string,
): Promise<string | null> {
  const params = new URLSearchParams();
  params.set('where[name][$eq]', name);
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[packageInstallId]', 'null');
  params.set('options[limit]', '2');
  const res = await apiFetch<{ data: ExistingWorkflow[] }>(
    client,
    `/workflows?${params.toString()}`,
  );
  const matches = res.data ?? [];
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Soft-resolve a connection name → target-org connection id (null on 0 or >1).
 * Mirrors resolveWorkflowByNameSoft — form-auth credential refs are best-effort.
 */
async function resolveConnectionByNameSoft(
  client: ApiClient,
  name: string,
): Promise<string | null> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[name][$eq]', name);
  params.set('options[limit]', '2');
  const res = await apiFetch<{ data: Array<{ id: string }> }>(
    client,
    `/connections?${params.toString()}`,
  );
  const matches = res.data ?? [];
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Rewrite a form trigger's name refs back to target-org ids — both the nested
 * workflow refs and the form-auth credential connections. No-op for non-form
 * triggers. (Pure rewrite lives in trigger-form-refs.ts; this does the async
 * name→id lookups it needs.)
 */
async function resolveFormRefs(
  client: ApiClient,
  config: Record<string, unknown> | undefined,
): Promise<{ config: Record<string, unknown> | undefined; warnings: string[] }> {
  const wfNames = collectFormWorkflowNames(config);
  const connNames = collectFormCredentialNames(config);
  if (wfNames.length === 0 && connNames.length === 0) return { config, warnings: [] };

  const workflowNameToId = new Map<string, string | null>();
  const connectionNameToId = new Map<string, string | null>();
  await Promise.all([
    ...[...new Set(wfNames)].map(async (n) => {
      workflowNameToId.set(n, await resolveWorkflowByNameSoft(client, n));
    }),
    ...[...new Set(connNames)].map(async (n) => {
      connectionNameToId.set(n, await resolveConnectionByNameSoft(client, n));
    }),
  ]);
  return formRefsToIds(config, { workflowNameToId, connectionNameToId });
}

async function listExistingTriggers(
  client: ApiClient,
  workflowId: string,
): Promise<ExistingTrigger[]> {
  const res = await apiFetch<ExistingTrigger[] | { data: ExistingTrigger[] }>(
    client,
    `/workflows/${workflowId}/triggers`,
  );
  const rows = Array.isArray(res) ? res : res.data || [];
  // Only ever match/update org-owned triggers — the installer owns package rows.
  return rows.filter((t) => !t.packageInstallId);
}

/**
 * Strip nested config fields the server owns before sending. On create the
 * server mints `webhook.secret` + `webhook.path`; on update the config merge
 * (`{ ...existing, ...incoming }`) preserves them when omitted — so dropping
 * them here means we never clobber a live secret or rotate a path. Schedule
 * QStash state (`qstashScheduleId` / `nextRun`) is re-synced server-side.
 */
function sanitizeConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!config) return config;
  const out = structuredClone(config);
  const webhook = out['webhook'] as Record<string, unknown> | undefined;
  if (webhook) {
    delete webhook['secret'];
    delete webhook['path'];
  }
  const schedule = out['schedule'] as Record<string, unknown> | undefined;
  if (schedule) {
    delete schedule['qstashScheduleId'];
    delete schedule['nextRun'];
  }
  return out;
}

// Fields the server fully owns / that key the file locally — never sent.
const NON_PAYLOAD_FIELDS = new Set([
  'id',
  'workflow', // resolved to workflowId via the path
  'workflowId',
  'organizationId',
  'packageInstallId',
  'orgSuid',
  'createdAt',
  'updatedAt',
  'lastTriggeredAt',
  'lastTriggerExecutionId',
  'triggerCount',
  'webhookUrl',
  'formUrl',
  'eventWebhookUrl',
  'eventWebhookSecret',
  'eventAssignmentId',
  'eventAuthRequired',
]);

export function buildPayload(def: TriggerFile): Record<string, unknown> {
  const body: Record<string, unknown> = { type: def.type };
  for (const [key, value] of Object.entries(def)) {
    if (NON_PAYLOAD_FIELDS.has(key)) continue;
    if (key === 'type' || key === 'config') continue;
    if (value === undefined) continue;
    body[key] = value;
  }
  const config = sanitizeConfig(def.config);
  if (config !== undefined) body['config'] = config;
  return body;
}

function createTrigger(
  client: ApiClient,
  workflowId: string,
  def: TriggerFile,
): Promise<CreatedTrigger> {
  const body = { ...buildPayload(def), organizationId: client.orgId };
  return apiFetch<CreatedTrigger>(client, `/workflows/${workflowId}/triggers`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function updateTrigger(
  client: ApiClient,
  workflowId: string,
  triggerId: string,
  def: TriggerFile,
): Promise<CreatedTrigger> {
  // PATCH accepts { name?, enabled?, config? }; type is immutable post-create.
  const body = buildPayload(def);
  delete body['type'];
  return apiFetch<CreatedTrigger>(
    client,
    `/workflows/${workflowId}/triggers/${triggerId}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

async function pushTriggerFile(
  client: ApiClient,
  filename: string,
  def: TriggerFile,
  dryRun: boolean,
): Promise<PushResult> {
  // Fail loudly if the parent workflow doesn't exist yet (push workflows first).
  const wf = await resolveWorkflowByName(client, def.workflow);

  // Form triggers: resolve nested workflow name refs → target-org ids and
  // filter credential ids to existing connections (soft — warns, never fails).
  const { config: resolvedConfig, warnings } = await resolveFormRefs(client, def.config);
  for (const w of warnings) console.error(`  ${colors.yellow('!')} ${w}`);
  def = { ...def, config: resolvedConfig };

  const existing = await listExistingTriggers(client, wf.id);
  const match = (def.id && existing.find((t) => t.id === def.id)) ||
    existing.find((t) => t.name && t.name === def.name);

  if (dryRun) {
    const verb = match ? 'update' : 'create';
    console.error(
      `  ${colors.dim(`(dry-run) would ${verb} ${def.type} trigger`)} ${colors.cyan(def.name)} ${
        colors.dim(`→ ${wf.name}`)
      }`,
    );
    return { filename, triggerName: def.name, workflowName: wf.name, action: 'skipped' };
  }

  if (match) {
    await updateTrigger(client, wf.id, match.id, def);
    console.error(`  ${colors.green('✓')} updated ${colors.dim(match.id)}`);
    return { filename, triggerName: def.name, workflowName: wf.name, action: 'updated' };
  }
  const created = await createTrigger(client, wf.id, def);
  console.error(`  ${colors.green('✓')} created ${colors.dim(created.id)}`);
  return {
    filename,
    triggerName: def.name,
    workflowName: wf.name,
    action: 'created',
    url: created.webhookUrl ?? created.formUrl,
    secret: created.config?.webhook?.secret,
  };
}

export interface TriggersPushOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  dryRun: boolean;
}

export async function runTriggersPush(opts: TriggersPushOptions): Promise<void> {
  const { client } = await openSession(opts, 'triggers push');
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
    if (entry.isFile && entry.name.endsWith('.json')) files.push(`${dir}/${entry.name}`);
  }
  files.sort();
  if (files.length === 0) {
    console.error(colors.red(`\nError: no .json files found in ${dir}`));
    Deno.exit(1);
  }

  console.error(
    `\nFound ${colors.bold(String(files.length))} trigger file(s) to push`,
  );

  const results: PushResult[] = [];
  for (const filePath of files) {
    const filename = filePath.split('/').pop() || filePath;
    let def: TriggerFile;
    try {
      def = JSON.parse(await Deno.readTextFile(filePath)) as TriggerFile;
    } catch (e) {
      console.error(`\n${colors.bold(`[${filename}]`)}`);
      console.error(`  ${colors.red('✗')} ${(e as Error).message}`);
      results.push({
        filename,
        triggerName: '?',
        workflowName: '?',
        action: 'failed',
        error: (e as Error).message,
      });
      continue;
    }

    const problems: string[] = [];
    if (!def.name) problems.push(`missing 'name'`);
    if (!def.type) problems.push(`missing 'type'`);
    if (!def.workflow) problems.push(`missing 'workflow' (the parent workflow name)`);
    console.error(
      `\n${colors.bold(`[${filename}]`)} → ${colors.cyan(def.name ?? '?')}`,
    );
    if (problems.length > 0) {
      console.error(`  ${colors.red('✗')} ${problems.join('; ')}`);
      results.push({
        filename,
        triggerName: def.name ?? '?',
        workflowName: def.workflow ?? '?',
        action: 'failed',
        error: problems.join('; '),
      });
      continue;
    }

    try {
      results.push(await pushTriggerFile(client, filename, def, opts.dryRun));
    } catch (e) {
      console.error(`  ${colors.red('✗')} ${(e as Error).message}`);
      results.push({
        filename,
        triggerName: def.name,
        workflowName: def.workflow,
        action: 'failed',
        error: (e as Error).message,
      });
    }
  }

  const created = results.filter((r) => r.action === 'created').length;
  const updated = results.filter((r) => r.action === 'updated').length;
  const failed = results.filter((r) => r.action === 'failed').length;
  console.error('\n' + colors.bold('Summary'));
  console.error(
    `  ${colors.green(`${created} created`)}, ${colors.yellow(`${updated} updated`)}, ${
      failed > 0 ? colors.red(`${failed} failed`) : `${failed} failed`
    }`,
  );

  // Stdout: capturable URL + one-time secret for each newly created trigger.
  const withSecret = results.filter((r) => r.url);
  if (!opts.dryRun && withSecret.length > 0) {
    console.log('');
    for (const r of withSecret) {
      console.log(r.url);
      if (r.secret) console.log(r.secret);
      console.log('');
    }
  }

  if (failed > 0) Deno.exit(1);
}
