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
import {
  createWorkflow,
  type ExistingWorkflow,
  findWorkflowById,
  findWorkflowByName,
  updateWorkflow,
  type WorkflowDefinition,
} from './workflows-save.ts';
import { createWorkflowLayoutEngine, formatWorkflowForPush } from './workflow-layout.ts';

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

type LogFn = (msg: string) => void;

/**
 * Pushes one workflow file. Output goes through `log` (not console.error
 * directly) so callers can buffer per-file output and flush atomically —
 * essential for parallel mode where many pushes interleave.
 *
 * The caller is responsible for the leading `[filename] → name` header so
 * it can prepend progress counters or other per-call context.
 */
async function pushWorkflowFile(
  client: ApiClient,
  filename: string,
  def: WorkflowDefinition,
  opts: { dryRun: boolean; createTriggers: boolean; regenerateSecrets: boolean },
  log: LogFn,
): Promise<PushResult> {
  if (opts.dryRun) {
    const triggerNote = opts.createTriggers
      ? ' + webhook trigger'
      : ' (workflow only — pass -t to also create webhook)';
    log(
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
    log(`  ${colors.green('✓')} updated workflow ${colors.dim(wf.id)}`);
  } else {
    wf = await createWorkflow(client, def);
    action = 'created';
    log(`  ${colors.green('✓')} created workflow ${colors.dim(wf.id)}`);
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
        log(`  ${colors.green('✓')} regenerated trigger secret`);
      } catch (e) {
        triggerAction = 'failed';
        log(
          `  ${colors.red('✗')} failed to regenerate secret: ${(e as Error).message}`,
        );
      }
    } else {
      triggerAction = 'existing';
      log(
        `  ${colors.dim('•')} webhook trigger already exists (using stored secret)`,
      );
    }
  } else {
    try {
      const created = await createWebhookTrigger(client, wf.id, def.name);
      webhookUrl = created.webhookUrl;
      secret = created.config?.webhook?.secret;
      triggerAction = 'created';
      log(`  ${colors.green('✓')} created webhook trigger`);
    } catch (e) {
      triggerAction = 'failed';
      log(
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

/**
 * Worker-pool push that respects the sub-workflow dep graph. Up to
 * `concurrency` files are in flight at once; a file only starts when every
 * file it depends on (within the push set) has completed.
 *
 * Cycle members can never have their deps resolved (they reference each
 * other), so they're treated as having zero remaining deps — same contract
 * as the sequential path, which appends them in alpha order. The engine's
 * runtime depth guard is what actually prevents recursive blowup.
 *
 * Per-file output is buffered and flushed atomically at completion so the
 * log stays readable even at high concurrency. The counter shows completion
 * order (which equals topo position at concurrency=1).
 */
async function pushParallel(
  client: ApiClient,
  ordered: PushFileNode[],
  parsedDefs: Map<string, WorkflowDefinition>,
  graph: {
    deps: Map<string, Set<string>>;
    dependents: Map<string, Set<string>>;
  },
  cycles: string[][],
  concurrency: number,
  opts: { dryRun: boolean; createTriggers: boolean; regenerateSecrets: boolean },
): Promise<PushResult[]> {
  const total = ordered.length;
  const results: PushResult[] = [];
  if (total === 0) return results;

  const cycleMembers = new Set(cycles.flat());
  const byFilename = new Map(ordered.map((n) => [n.filename, n]));

  const inDegree = new Map<string, number>();
  for (const node of ordered) {
    const cnt = cycleMembers.has(node.filename) ? 0 : (graph.deps.get(node.filename)?.size ?? 0);
    inDegree.set(node.filename, cnt);
  }

  // Stable order: alpha within a level so output is deterministic at
  // concurrency=1 (matches the existing sequential behavior).
  const ready: string[] = [];
  for (const [fname, deg] of inDegree) {
    if (deg === 0) ready.push(fname);
  }
  ready.sort();

  const counterWidth = String(total).length;
  let completed = 0;
  const waiters: Array<() => void> = [];
  const wake = (): void => {
    const w = waiters.shift();
    if (w) w();
  };
  const wakeAll = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  const wait = (): Promise<void> =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
    });

  const insertReady = (filename: string): void => {
    // Binary-search insert keeps `ready` alpha-sorted for stable scheduling.
    let lo = 0;
    let hi = ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ready[mid] < filename) lo = mid + 1;
      else hi = mid;
    }
    ready.splice(lo, 0, filename);
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const filename = ready.shift();
      if (!filename) {
        if (completed === total) {
          wakeAll();
          return;
        }
        await wait();
        continue;
      }

      const node = byFilename.get(filename);
      if (!node) continue;
      const short = node.filename.split('/').pop() || node.filename;
      const def = parsedDefs.get(node.filename);

      const buf: string[] = [];
      const log: LogFn = (m) => buf.push(m);
      let errorMessage: string | undefined;

      try {
        if (!def) throw new Error('definition not loaded');
        const r = await pushWorkflowFile(client, short, def, opts, log);
        results.push(r);
      } catch (e) {
        errorMessage = (e as Error).message;
      }

      completed++;
      const counter = `[${String(completed).padStart(counterWidth)}/${total}]`;
      const displayName = def?.name ?? short;
      console.error(
        `\n${counter} ${colors.bold(`[${short}]`)} → ${colors.cyan(displayName)}`,
      );
      if (errorMessage) {
        console.error(`  ${colors.red('✗')} ${errorMessage}`);
      }
      if (buf.length > 0) console.error(buf.join('\n'));

      for (const child of graph.dependents.get(node.filename) ?? []) {
        if (cycleMembers.has(child)) continue;
        const rem = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, rem);
        if (rem === 0) {
          insertReady(child);
          wake();
        }
      }

      if (completed === total) wakeAll();
    }
  };

  const n = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
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
  dryRun: boolean;
  createTriggers: boolean;
  regenerateSecrets: boolean;
  /**
   * Max files pushed in parallel. Workers respect the sub-workflow dep
   * graph — a file only starts after every file it depends on has finished.
   * 1 = strictly sequential (legacy behavior). Default 8 is a safe balance
   * for typical org-size pushes; bump to 32–64 for large independent sets
   * (1k+ workflows with few cross-refs).
   */
  concurrency?: number;
}

export async function runWorkflowsPush(
  opts: WorkflowsPushOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'push');
  const dir = resolve(opts.dir);
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  console.error(`  Dir:  ${dir}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );
  console.error(`  Concurrency: ${colors.bold(String(concurrency))}`);

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
  // The full parsed def is retained per-file so the worker pool doesn't
  // re-read and re-parse during push.
  const nodes: PushFileNode[] = [];
  const parsedDefs = new Map<string, WorkflowDefinition>();
  const parseErrors: Array<{ filename: string; error: Error }> = [];
  const layoutEngine = createWorkflowLayoutEngine();
  try {
    for (const filePath of files) {
      const filename = filePath.split('/').pop() || filePath;
      try {
        const raw = await Deno.readTextFile(filePath);
        const parsedDef = JSON.parse(raw) as WorkflowDefinition;
        const def = await formatWorkflowForPush(parsedDef, layoutEngine);
        if (!def.name) {
          throw new Error(`missing 'name' field`);
        }
        parsedDefs.set(filePath, def);
        nodes.push({
          filename: filePath,
          def: { id: def.id, name: def.name, steps: def.steps },
          refs: extractSubWorkflowRefs({ steps: def.steps }),
        });
      } catch (e) {
        parseErrors.push({ filename, error: e as Error });
      }
    }
  } finally {
    layoutEngine.dispose();
  }
  for (const { filename, error } of parseErrors) {
    console.error(`  ${colors.red('✗')} ${filename}: ${error.message}`);
  }

  let ordered: PushFileNode[];
  let unresolved: ReturnType<typeof topoSortFiles>['unresolved'];
  let cycles: string[][];
  let deps: Map<string, Set<string>>;
  let dependents: Map<string, Set<string>>;
  try {
    const sorted = topoSortFiles(nodes);
    ordered = sorted.order;
    unresolved = sorted.unresolved;
    cycles = sorted.cycles;
    deps = sorted.deps;
    dependents = sorted.dependents;
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

  const results = await pushParallel(
    client,
    ordered,
    parsedDefs,
    { deps, dependents },
    cycles,
    concurrency,
    {
      dryRun: opts.dryRun,
      createTriggers: opts.createTriggers,
      regenerateSecrets: opts.regenerateSecrets,
    },
  );

  printSummary(results, opts.createTriggers);
  if (!opts.dryRun && opts.createTriggers) {
    printTriggerOutputs(results);
  }
}
