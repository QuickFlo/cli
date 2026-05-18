/**
 * `quickflo connections pull` — download connections into a local directory
 * as pushable JSON files. Plaintext config by default; `--mask` for `"***"`
 * placeholders (safe to commit / share for inspection only).
 */

import { colors } from '@cliffy/ansi/colors';
import { join, resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import {
  type ConnectionRecord,
  fetchConfig,
  maskConfig,
  toPushableShape,
} from './connections-get.ts';
import { listOAuthProviders } from './connections-oauth.ts';
import { openSession } from './session.ts';

interface ConnectionListResponse {
  data: ConnectionRecord[];
}

async function listConnections(
  client: ApiClient,
  opts: ListOptions,
): Promise<ConnectionRecord[]> {
  const userLimit = opts.limit;
  const pageSize = userLimit ? Math.min(userLimit, 100) : 100;
  let offset = 0;
  const all: ConnectionRecord[] = [];
  while (true) {
    const params = buildListParams({
      ...opts,
      limit: pageSize,
      order: opts.order ?? 'name:ASC',
    });
    params.set('where[organizationId][$eq]', client.orgId);
    params.set('options[offset]', String(offset));
    const res = await apiFetch<ConnectionListResponse>(
      client,
      `/connections?${params.toString()}`,
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
    .slice(0, 80) || 'connection';
}

function assignFilenames(
  conns: ConnectionRecord[],
): Array<{ conn: ConnectionRecord; filename: string }> {
  const sorted = [...conns].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const used = new Map<string, number>();
  const out: Array<{ conn: ConnectionRecord; filename: string }> = [];
  for (const conn of sorted) {
    const base = slugify(conn.name);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const filename = count === 0 ? `${base}.json` : `${base}-${conn.id.slice(0, 8)}.json`;
    out.push({ conn, filename });
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

export interface ConnectionsPullOptions extends ListOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  force: boolean;
  dryRun: boolean;
  mask?: boolean;
}

export async function runConnectionsPull(
  opts: ConnectionsPullOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'connections pull');
  const dir = resolve(opts.dir);
  console.error(`  Dir:  ${dir}`);
  if (opts.name) console.error(`  Name filter: ${opts.name}`);
  for (const w of opts.where ?? []) console.error(`  Where: ${w}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );
  console.error(
    `  Secrets: ${opts.mask ? colors.yellow('MASKED ("***")') : colors.green('PLAINTEXT')}`,
  );

  const [conns, providers] = await Promise.all([
    listConnections(client, {
      name: opts.name,
      where: opts.where,
      rawQuery: opts.rawQuery,
      limit: opts.limit,
      order: opts.order,
    }),
    listOAuthProviders(client),
  ]);
  const oauthTypes = new Set(providers.map((p) => p.id));
  const pushable = conns.filter((c) => !oauthTypes.has(c.type));
  const oauth = conns.filter((c) => oauthTypes.has(c.type));

  console.error(
    `\nFound ${
      colors.bold(String(conns.length))
    } connection(s) in org (${pushable.length} pushable, ${oauth.length} OAuth-skipped)`,
  );
  if (conns.length === 0) return;

  if (!opts.dryRun) await Deno.mkdir(dir, { recursive: true });

  if (!opts.mask && pushable.length > 0) {
    console.error(
      colors.yellow(
        '  ! plaintext secrets written to disk — add this directory to .gitignore',
      ),
    );
  }

  let written = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const { conn, filename } of assignFilenames(pushable)) {
    const fullPath = join(dir, filename);
    const rawConfig = await fetchConfig(client, conn.id);
    const config = opts.mask ? maskConfig(rawConfig) : rawConfig;
    const payload = JSON.stringify(toPushableShape(conn, config), null, 2) + '\n';

    console.error(`\n${colors.bold(`[${filename}]`)} ← ${colors.cyan(conn.name)}`);

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
    console.error(`  ${colors.green('✓')} wrote ${colors.dim(conn.id)}`);
    written++;
  }

  if (oauth.length > 0) {
    const indexPath = join(dir, '_skipped_oauth.json');
    const indexPayload = JSON.stringify(
      oauth.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      null,
      2,
    ) + '\n';
    if (!opts.dryRun) await Deno.writeTextFile(indexPath, indexPayload);
    console.error(
      `\n${colors.dim('•')} ${oauth.length} OAuth connection(s) skipped — see ${indexPath}`,
    );
    console.error(
      colors.dim(
        '  Re-create or re-auth with `quickflo connections create --type <provider> --name "<name>"`.',
      ),
    );
  }

  console.error('\n' + colors.bold('Summary'));
  console.error(
    `  ${colors.green(`${written} written`)}, ${unchanged} unchanged, ${
      skipped > 0 ? colors.yellow(`${skipped} skipped`) : `${skipped} skipped`
    }`,
  );
}
