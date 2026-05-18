/**
 * `quickflo environments pull` — download environments into a local directory
 * as pushable JSON files (`{ name, variables: { key: value } }`). Plaintext
 * by default; `--mask` writes `"***"` placeholders.
 */

import { colors } from '@cliffy/ansi/colors';
import { join, resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import {
  type EnvironmentRecord,
  fetchVariables,
  maskVariables,
  toPushableShape,
} from './environments-get.ts';
import { openSession } from './session.ts';

interface EnvironmentListResponse {
  data: EnvironmentRecord[];
}

async function listEnvironments(
  client: ApiClient,
  opts: ListOptions,
): Promise<EnvironmentRecord[]> {
  const userLimit = opts.limit;
  const pageSize = userLimit ? Math.min(userLimit, 100) : 100;
  let offset = 0;
  const all: EnvironmentRecord[] = [];
  while (true) {
    const params = buildListParams({
      ...opts,
      limit: pageSize,
      order: opts.order ?? 'name:ASC',
    });
    params.set('where[organizationId][$eq]', client.orgId);
    params.set('options[offset]', String(offset));
    const res = await apiFetch<EnvironmentListResponse>(
      client,
      `/environments?${params.toString()}`,
    );
    const page = res.data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    if (userLimit && all.length >= userLimit) return all.slice(0, userLimit);
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
    .slice(0, 80) || 'environment';
}

function assignFilenames(
  envs: EnvironmentRecord[],
): Array<{ env: EnvironmentRecord; filename: string }> {
  const sorted = [...envs].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const used = new Map<string, number>();
  const out: Array<{ env: EnvironmentRecord; filename: string }> = [];
  for (const env of sorted) {
    const base = slugify(env.name);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const filename = count === 0 ? `${base}.json` : `${base}-${env.id.slice(0, 8)}.json`;
    out.push({ env, filename });
  }
  return out;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

export interface EnvironmentsPullOptions extends ListOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  force: boolean;
  dryRun: boolean;
  mask?: boolean;
}

export async function runEnvironmentsPull(
  opts: EnvironmentsPullOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'environments pull');
  const dir = resolve(opts.dir);
  console.error(`  Dir:  ${dir}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );
  console.error(
    `  Secrets: ${opts.mask ? colors.yellow('MASKED ("***")') : colors.green('PLAINTEXT')}`,
  );

  const envs = await listEnvironments(client, {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order,
  });
  console.error(
    `\nFound ${colors.bold(String(envs.length))} environment(s) in org`,
  );
  if (envs.length === 0) return;

  if (!opts.dryRun) await Deno.mkdir(dir, { recursive: true });
  if (!opts.mask) {
    console.error(
      colors.yellow(
        '  ! plaintext secrets written to disk — add this directory to .gitignore',
      ),
    );
  }

  let written = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const { env, filename } of assignFilenames(envs)) {
    const fullPath = join(dir, filename);
    const raw = await fetchVariables(client, env.id);
    const variables = opts.mask ? maskVariables(raw) : raw;
    const payload = JSON.stringify(toPushableShape(env, variables), null, 2) + '\n';

    console.error(`\n${colors.bold(`[${filename}]`)} ← ${colors.cyan(env.name)}`);

    if (opts.dryRun) {
      console.error(`  ${colors.dim('(dry-run) would write')} ${fullPath}`);
      skipped++;
      continue;
    }
    const existing = await readIfExists(fullPath);
    if (existing === payload) {
      console.error(`  ${colors.dim('•')} unchanged`);
      unchanged++;
      continue;
    }
    if (existing !== null && !opts.force) {
      console.error(
        `  ${colors.yellow('!')} local file differs — pass --force to overwrite`,
      );
      skipped++;
      continue;
    }
    await Deno.writeTextFile(fullPath, payload);
    console.error(`  ${colors.green('✓')} wrote ${colors.dim(env.id)}`);
    written++;
  }

  console.error('\n' + colors.bold('Summary'));
  console.error(
    `  ${colors.green(`${written} written`)}, ${unchanged} unchanged, ${
      skipped > 0 ? colors.yellow(`${skipped} skipped`) : `${skipped} skipped`
    }`,
  );
}
