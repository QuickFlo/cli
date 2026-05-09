/**
 * `quickflo workflows pull` command — downloads workflow definitions from an
 * organization and writes them as JSON files into a local directory. Output
 * shape matches what `workflows push` reads.
 */

import { colors } from '@cliffy/ansi/colors';
import { join, resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import {
  applyTagsFilter,
  applyTemplateFilter,
  buildListParams,
  type ListOptions,
  parseTags,
  type TagsMode,
  type TemplateFilter,
} from './filters.ts';
import { openSession } from './session.ts';

/**
 * Loose shape: the CLI explicitly only knows about a handful of fields
 * that affect filtering/filename derivation/sorting. Everything else
 * passes through to the file via the denylist-based serializer below
 * — the server is the validation source of truth, and any field the
 * server adds in the future round-trips automatically. Avoids the
 * silent-drop class of bug that an allowlist invites.
 */
interface RemoteWorkflow {
  id: string;
  name: string;
  description?: string;
  isTemplate?: boolean;
  isPublic?: boolean;
  tags?: string[];
  // Loose-typed for everything else — see SERVER_MANAGED_FIELDS.
  [key: string]: unknown;
}

interface WorkflowListResponse {
  data: RemoteWorkflow[];
  total: number;
}

interface PullResult {
  workflowName: string;
  workflowId: string;
  filename: string;
  action: 'written' | 'unchanged' | 'skipped';
}

interface PullFilters {
  templateFilter: TemplateFilter;
  tags: string[];
  tagsMode: TagsMode;
}

async function listWorkflows(
  client: ApiClient,
  filters: ListOptions & PullFilters,
): Promise<RemoteWorkflow[]> {
  const userLimit = filters.limit;
  const pageSize = userLimit ? Math.min(userLimit, 100) : 100;
  let offset = 0;
  const all: RemoteWorkflow[] = [];
  while (true) {
    const params = buildListParams({
      ...filters,
      limit: pageSize,
      order: filters.order ?? 'name:ASC',
    });
    params.set('where[organizationId][$eq]', client.orgId);
    applyTemplateFilter(params, filters.templateFilter);
    applyTagsFilter(params, filters.tags, filters.tagsMode);
    params.set('options[offset]', String(offset));
    const res = await apiFetch<WorkflowListResponse>(
      client,
      `/workflows?${params.toString()}`,
    );
    const page = res.data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    if (userLimit && all.length >= userLimit) {
      return all.slice(0, userLimit);
    }
    offset += pageSize;
  }
  return all;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workflow';
}

/**
 * Server-managed fields stripped from the pulled file shape. The CLI
 * uses a denylist (not an allowlist) so any field the server adds in
 * the future flows through to the file without a CLI patch — silent
 * drops are the fail mode we're explicitly avoiding here.
 *
 * Fields are managed server-side and have no business round-tripping
 * through user-edited JSON: ids, audit timestamps, ownership, and
 * fields the engine derives from the definition (used-action-types).
 * `id` is the one exception we preserve in the file — push uses it as
 * a stable handle so renames don't double-create.
 */
const SERVER_MANAGED_FIELDS = new Set([
  'organizationId',
  'packageInstallId',
  'createdAt',
  'updatedAt',
  'userId',
  'usedActionTypes',
]);

function buildFileShape(wf: RemoteWorkflow): Record<string, unknown> {
  const definition = (wf['definition'] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Pass through every top-level field except server-managed ones.
  // `definition` is unwrapped below (its `steps`/`initial`/`environment`
  // are surfaced at the top level so the file shape matches what
  // workflows-push expects to read).
  for (const [key, value] of Object.entries(wf)) {
    if (SERVER_MANAGED_FIELDS.has(key)) continue;
    if (key === 'definition') continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  // Unwrap the definition's user-authored fields onto the top level.
  if (definition['environment']) out['environment'] = definition['environment'];
  if (definition['initial'] !== undefined) out['initial'] = definition['initial'];
  out['steps'] = definition['steps'] ?? [];
  return out;
}

// Deterministic ordering by (name, id) so repeated pulls always assign the
// same filename to the same workflow, even when two workflows share a name.
function assignFilenames(
  workflows: RemoteWorkflow[],
): Array<{ wf: RemoteWorkflow; filename: string }> {
  const sorted = [...workflows].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const used = new Map<string, number>();
  const result: Array<{ wf: RemoteWorkflow; filename: string }> = [];
  for (const wf of sorted) {
    const base = slugify(wf.name);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const filename = count === 0 ? `${base}.json` : `${base}-${wf.id.slice(0, 8)}.json`;
    result.push({ wf, filename });
  }
  return result;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

export interface WorkflowsPullOptions extends ListOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  username?: string;
  password?: string;
  force: boolean;
  dryRun: boolean;
  noCache?: boolean;
  /** `all` (default) includes templates + workflows, `only` = templates only, `exclude` = workflows only. */
  templates?: TemplateFilter;
  tags?: string | string[];
  tagsAll?: boolean;
}

export async function runWorkflowsPull(
  opts: WorkflowsPullOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'pull');
  const dir = resolve(opts.dir);
  console.error(`  Dir:  ${dir}`);
  if (opts.name) console.error(`  Name filter: ${opts.name}`);
  for (const w of opts.where ?? []) console.error(`  Where: ${w}`);
  if (opts.rawQuery) console.error(`  Raw:   ${opts.rawQuery}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );

  const workflows = await listWorkflows(client, {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order,
    templateFilter: opts.templates ?? 'all',
    tags: parseTags(opts.tags),
    tagsMode: opts.tagsAll ? 'all' : 'any',
  });
  console.error(
    `\nFound ${colors.bold(String(workflows.length))} workflow(s) in org`,
  );
  if (workflows.length === 0) return;

  if (!opts.dryRun) {
    await Deno.mkdir(dir, { recursive: true });
  }

  const assignments = assignFilenames(workflows);
  const results: PullResult[] = [];

  for (const { wf, filename } of assignments) {
    const fullPath = join(dir, filename);
    const payload = JSON.stringify(buildFileShape(wf), null, 2) + '\n';

    console.error(
      `\n${colors.bold(`[${filename}]`)} ← ${colors.cyan(wf.name)}`,
    );

    if (opts.dryRun) {
      console.error(`  ${colors.dim('(dry-run) would write')} ${fullPath}`);
      results.push({
        workflowName: wf.name,
        workflowId: wf.id,
        filename,
        action: 'skipped',
      });
      continue;
    }

    const existing = await readIfExists(fullPath);
    if (existing === payload) {
      console.error(`  ${colors.dim('•')} unchanged`);
      results.push({
        workflowName: wf.name,
        workflowId: wf.id,
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
        workflowName: wf.name,
        workflowId: wf.id,
        filename,
        action: 'skipped',
      });
      continue;
    }
    await Deno.writeTextFile(fullPath, payload);
    console.error(`  ${colors.green('✓')} wrote ${colors.dim(wf.id)}`);
    results.push({
      workflowName: wf.name,
      workflowId: wf.id,
      filename,
      action: 'written',
    });
  }

  const written = results.filter((r) => r.action === 'written').length;
  const unchanged = results.filter((r) => r.action === 'unchanged').length;
  const skipped = results.filter((r) => r.action === 'skipped').length;
  console.error('\n' + colors.bold('Summary'));
  console.error(
    `  ${colors.green(`${written} written`)}, ${unchanged} unchanged, ${
      skipped > 0 ? colors.yellow(`${skipped} skipped`) : `${skipped} skipped`
    }`,
  );
}
