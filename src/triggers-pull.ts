/**
 * `quickflo triggers pull` command — downloads triggers (webhook, schedule,
 * event, form) from an organization and writes them as JSON files into a local
 * directory. Output shape matches what `triggers push` reads.
 *
 * The defining difference from `workflows pull`: a trigger's parent link is
 * stored as a workflow *name* (`"workflow": "<name>"`) instead of the server's
 * `workflowId` UUID, so the file re-associates by name on push — making trigger
 * configs portable across orgs (see triggers-push.ts).
 */

import { colors } from '@cliffy/ansi/colors';
import { join, resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { resolveInstallAddresses } from './package-installs.ts';
import { type Lookup } from './refs.ts';
import { resolveWorkflowNames, resolveWorkflowRef } from './workflow-refs.ts';
import {
  collectFormCredentialIds,
  collectFormWorkflowIds,
  formRefsToNames,
} from './trigger-form-refs.ts';
import { openSession } from './session.ts';

/**
 * Loose shape: the CLI only types the handful of fields it reads for
 * filename derivation, association, and provenance. Everything else passes
 * through to the file via the denylist-based serializer below — the server's
 * Zod (createTriggerSchema) is the validation source of truth, so any field
 * the server adds later round-trips automatically. Same denylist philosophy
 * as workflows-pull (avoids the silent-drop class of bug an allowlist invites).
 */
export interface RemoteTrigger {
  id: string;
  workflowId?: string;
  packageInstallId?: string | null;
  type: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

interface TriggerListResponse {
  data: RemoteTrigger[];
  total: number;
}

interface PullResult {
  triggerName: string;
  triggerId: string;
  filename: string;
  action: 'written' | 'unchanged' | 'skipped';
}

/**
 * Server-managed top-level fields stripped from the pulled file shape. Denylist
 * (not allowlist) so a new server field flows through without a CLI patch.
 *
 * `workflowId` is stripped and replaced by `workflow: "<name>"` — the whole
 * point of the feature. `id` is preserved (like workflows) so a same-org
 * re-push finds the same row by id even after a rename; cross-org pushes fall
 * back to name matching since trigger ids can't be pinned on create.
 *
 * The computed URL/secret fields (`webhookUrl`, `formUrl`, `eventWebhookUrl`,
 * `eventWebhookSecret`, `eventAssignmentId`, `eventAuthRequired`) are built in
 * the DTO from `orgSuid` + `name`, never stored — they have no business in a
 * user-edited file and are environment-specific.
 */
const SERVER_MANAGED_FIELDS = new Set([
  'organizationId',
  'packageInstallId',
  'workflowId',
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

/**
 * Deep-strip server-managed nested config fields. The list/get endpoints
 * decrypt `config.webhook.secret` to plaintext (getDecryptedTriggerData), so
 * we drop it deliberately — persisting live secrets to disk would leak them
 * into git, and secrets are environment-local by design (a fresh secret is
 * minted server-side on create; an existing one is left untouched on update).
 *
 * `config.webhook.path` is auto-generated; `config.schedule.qstashScheduleId`
 * / `config.schedule.nextRun` are QStash runtime state the server re-syncs.
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

export function buildFileShape(
  trigger: RemoteTrigger,
  workflowName: string,
  refMaps?: { workflowIdToName: Map<string, string>; connectionIdToName: Map<string, string> },
): { shape: Record<string, unknown>; warnings: string[] } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(trigger)) {
    if (SERVER_MANAGED_FIELDS.has(key)) continue;
    if (key === 'config') continue; // sanitized below
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  // Name-based association: the file points at the workflow by name, not UUID.
  out['workflow'] = workflowName;
  let config = sanitizeConfig(trigger.config);
  // Form triggers: rewrite nested workflow + connection id refs to names so
  // they round-trip across orgs.
  const { config: rewritten, warnings } = formRefsToNames(config, {
    workflowIdToName: refMaps?.workflowIdToName ?? new Map(),
    connectionIdToName: refMaps?.connectionIdToName ?? new Map(),
  });
  config = rewritten;
  if (config !== undefined) out['config'] = config;
  return { shape: out, warnings };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'trigger';
}

// Deterministic (name, id) ordering so repeated pulls assign the same filename
// to the same trigger. Trigger names are globally unique per org, so a slug
// collision is only possible across different-cased / punctuated names — the
// id-suffix fallback handles it the same way workflows-pull does.
function assignFilenames(
  triggers: RemoteTrigger[],
): Array<{ trigger: RemoteTrigger; filename: string }> {
  const sorted = [...triggers].sort(
    (a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id),
  );
  const used = new Map<string, number>();
  const result: Array<{ trigger: RemoteTrigger; filename: string }> = [];
  for (const trigger of sorted) {
    const base = slugify(trigger.name ?? trigger.type);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const filename = count === 0 ? `${base}.json` : `${base}-${trigger.id.slice(0, 8)}.json`;
    result.push({ trigger, filename });
  }
  return result;
}

async function listTriggers(
  client: ApiClient,
  path: string,
  filters: ListOptions,
): Promise<RemoteTrigger[]> {
  const userLimit = filters.limit;
  const pageSize = userLimit ? Math.min(userLimit, 100) : 100;
  let offset = 0;
  const all: RemoteTrigger[] = [];
  while (true) {
    const params = buildListParams({
      ...filters,
      limit: pageSize,
      order: filters.order ?? 'name:ASC',
    });
    params.set('options[offset]', String(offset));
    const res = await apiFetch<TriggerListResponse>(
      client,
      `${path}?${params.toString()}`,
    );
    const page = res.data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    if (userLimit && all.length >= userLimit) return all.slice(0, userLimit);
    offset += pageSize;
  }
  return all;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Batch-resolve connection ids → names (for form-auth credential refs). */
async function resolveConnectionNames(
  client: ApiClient,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  if (unique.length === 1) {
    params.set('where[id][$eq]', unique[0]);
  } else {
    for (const id of unique) params.append('where[id][$in][]', id);
  }
  params.set('options[limit]', String(unique.length));
  const res = await apiFetch<{ data: Array<{ id: string; name: string }> }>(
    client,
    `/connections?${params.toString()}`,
  );
  for (const c of res.data ?? []) out.set(c.id, c.name);
  return out;
}

export interface TriggersPullOptions extends ListOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  force: boolean;
  dryRun: boolean;
  /** Scope the pull to a single workflow (UUID, SUID, or name). */
  workflow?: string;
  by?: Lookup;
  /** Include triggers installed from packages. Defaults to false (org-owned only). */
  includePackages?: boolean;
}

export async function runTriggersPull(opts: TriggersPullOptions): Promise<void> {
  const { client } = await openSession(opts, 'triggers pull');
  const dir = resolve(opts.dir);
  console.error(`  Dir:  ${dir}`);

  // Org-wide by default; --workflow scopes to one workflow's triggers.
  let path: string;
  let scopeWorkflow: { id: string; name: string } | undefined;
  if (opts.workflow) {
    const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
    path = `/workflows/${wf.id}/triggers`;
    scopeWorkflow = { id: wf.id, name: wf.name };
    console.error(`  Scope: workflow ${colors.cyan(wf.name)}`);
  } else {
    path = '/triggers';
    console.error(`  Scope: all triggers in org`);
  }
  if (opts.name) console.error(`  Name filter: ${opts.name}`);
  for (const w of opts.where ?? []) console.error(`  Where: ${w}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );

  const includePackages = opts.includePackages ?? false;
  if (!includePackages) {
    console.error(
      colors.dim(
        '  Scope: org-owned triggers only (pass --include-packages to also pull package-installed triggers)',
      ),
    );
  }

  let triggers = await listTriggers(client, path, {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order,
  });
  // Filter package-managed rows client-side. The org-wide endpoint accepts a
  // where[packageInstallId]=null filter, but the per-workflow path may not, so
  // we filter here uniformly for both code paths.
  if (!includePackages) {
    triggers = triggers.filter((t) => !t.packageInstallId);
  }

  console.error(
    `\nFound ${colors.bold(String(triggers.length))} trigger(s) in scope`,
  );
  if (triggers.length === 0) return;

  // Resolve every referenced workflowId → name so the file can store names.
  // Includes each trigger's parent workflow AND any workflows referenced from
  // form configs (prefill / confirmation / chat.endedWorkflow), which may be
  // different workflows than the trigger's own — so we always batch-resolve.
  const referencedIds = new Set<string>();
  for (const t of triggers) {
    if (t.workflowId) referencedIds.add(t.workflowId);
    for (const id of collectFormWorkflowIds(t.config)) referencedIds.add(id);
  }
  if (scopeWorkflow) referencedIds.add(scopeWorkflow.id);

  // Form-auth credential connection ids referenced across the pulled triggers.
  const credentialIds = new Set<string>();
  for (const t of triggers) {
    for (const id of collectFormCredentialIds(t.config)) credentialIds.add(id);
  }

  const [workflowNames, connectionNames] = await Promise.all([
    resolveWorkflowNames(client, referencedIds),
    resolveConnectionNames(client, credentialIds),
  ]);

  // Provenance for package rows (only when --include-packages surfaced any).
  const installIds = triggers
    .map((t) => t.packageInstallId)
    .filter((id): id is string => !!id);
  const packageAddresses = await resolveInstallAddresses(client, installIds);

  if (!opts.dryRun) {
    await Deno.mkdir(dir, { recursive: true });
  }

  const assignments = assignFilenames(triggers);
  const results: PullResult[] = [];
  let skippedUnnamed = 0;
  let skippedUnresolved = 0;

  for (const { trigger, filename } of assignments) {
    // Name-based association requires the trigger to have a name (it's the
    // match key on push) AND its workflow to resolve to a name.
    if (!trigger.name) {
      console.error(
        `  ${colors.yellow('!')} skipping unnamed ${trigger.type} trigger ${
          colors.dim(trigger.id)
        } — push matches by name, so unnamed triggers can't round-trip`,
      );
      skippedUnnamed++;
      continue;
    }
    const wfName = trigger.workflowId ? workflowNames.get(trigger.workflowId) : undefined;
    if (!wfName) {
      console.error(
        `  ${colors.yellow('!')} skipping trigger ${colors.cyan(trigger.name)} ${
          colors.dim(trigger.id)
        } — its workflow (${trigger.workflowId ?? 'none'}) isn't an org-owned workflow we can name`,
      );
      skippedUnresolved++;
      continue;
    }

    const fullPath = join(dir, filename);
    const { shape, warnings } = buildFileShape(trigger, wfName, {
      workflowIdToName: workflowNames,
      connectionIdToName: connectionNames,
    });
    const payload = JSON.stringify(shape, null, 2) + '\n';

    const pkgAddr = trigger.packageInstallId
      ? (packageAddresses.get(trigger.packageInstallId) ?? '?')
      : null;
    const provenance = pkgAddr ? ` ${colors.dim(`[from ${pkgAddr}]`)}` : '';
    console.error(
      `\n${colors.bold(`[${filename}]`)} ← ${colors.cyan(trigger.name)} ${
        colors.dim(`(${trigger.type} → ${wfName})`)
      }${provenance}`,
    );
    for (const w of warnings) console.error(`  ${colors.yellow('!')} ${w}`);

    if (opts.dryRun) {
      console.error(`  ${colors.dim('(dry-run) would write')} ${fullPath}`);
      results.push({
        triggerName: trigger.name,
        triggerId: trigger.id,
        filename,
        action: 'skipped',
      });
      continue;
    }

    const existing = await readIfExists(fullPath);
    if (existing === payload) {
      console.error(`  ${colors.dim('•')} unchanged`);
      results.push({
        triggerName: trigger.name,
        triggerId: trigger.id,
        filename,
        action: 'unchanged',
      });
      continue;
    }
    if (existing !== null && !opts.force) {
      console.error(
        `  ${colors.yellow('!')} local file differs — pass --force to overwrite`,
      );
      results.push({
        triggerName: trigger.name,
        triggerId: trigger.id,
        filename,
        action: 'skipped',
      });
      continue;
    }
    await Deno.writeTextFile(fullPath, payload);
    console.error(`  ${colors.green('✓')} wrote ${colors.dim(trigger.id)}`);
    results.push({ triggerName: trigger.name, triggerId: trigger.id, filename, action: 'written' });
  }

  const written = results.filter((r) => r.action === 'written').length;
  const unchanged = results.filter((r) => r.action === 'unchanged').length;
  const skipped = results.filter((r) => r.action === 'skipped').length;
  console.error('\n' + colors.bold('Summary'));
  console.error(
    `  ${colors.green(`${written} written`)}, ${unchanged} unchanged, ${skipped} skipped` +
      (skippedUnnamed > 0 ? `, ${colors.yellow(`${skippedUnnamed} unnamed`)}` : '') +
      (skippedUnresolved > 0
        ? `, ${colors.yellow(`${skippedUnresolved} unresolved-workflow`)}`
        : ''),
  );
}
