/**
 * `quickflo backup` — pull everything worth keeping from an org into one neat
 * folder, ready to push elsewhere. It orchestrates the per-resource pull
 * runners (workflows, connections, environments, triggers) plus a data-store
 * dump, each into its own subdirectory:
 *
 *   <root>/
 *     workflows/      ← workflows pull
 *     connections/    ← connections pull
 *     environments/   ← environments pull
 *     triggers/       ← triggers pull   (refs stored by name, so they re-link)
 *     data-stores/    ← one <table>.json per data-store table (if supported)
 *
 * The root defaults to the org's name (slugified), so `quickflo backup` drops a
 * folder named after the org you're pointed at. Pass `-d` to override.
 *
 * Each resource is best-effort and isolated: a failure (or an unsupported
 * surface like data-stores on an org that doesn't have them) is reported in the
 * summary but never aborts the rest of the backup.
 */

import { colors } from '@cliffy/ansi/colors';
import { join, resolve } from '@std/path';
import { type ApiClient } from './api.ts';
import { ApiError } from './errors.ts';
import { openSession } from './session.ts';
import { runWorkflowsPull } from './workflows-pull.ts';
import { runConnectionsPull } from './connections-pull.ts';
import { runEnvironmentsPull } from './environments-pull.ts';
import { runTriggersPull } from './triggers-pull.ts';
import { fetchTables } from './data-stores-tables.ts';
import { fetchAllEntries } from './data-stores-export.ts';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

type StepStatus = 'ok' | 'skipped' | 'truncated' | 'failed';

/**
 * Dump every data-store table to `<dir>/<table>.json` (a `{key, value}[]`
 * array, the same shape `data-stores import` reads). Each table is capped at
 * `recordLimit` entries so one huge table can't blow up the snapshot; a capped
 * table is flagged loudly so the backup is never silently incomplete. Returns
 * 'skipped' when the org has no data-store surface (404/501).
 */
async function backupDataStores(
  client: ApiClient,
  dir: string,
  dryRun: boolean,
  recordLimit: number,
): Promise<StepStatus> {
  let tables: Array<{ tableName: string }>;
  try {
    tables = await fetchTables(client, { all: true });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
      console.error(colors.dim('  data-stores not available on this org — skipping'));
      return 'skipped';
    }
    throw e;
  }

  console.error(
    `  Found ${colors.bold(String(tables.length))} table(s) ${
      colors.dim(`(cap ${recordLimit} records/table — raise with --data-store-limit)`)
    }`,
  );
  if (tables.length === 0) return 'ok';
  if (!dryRun) await Deno.mkdir(dir, { recursive: true });

  let truncated = false;
  for (const t of tables) {
    // Fetch one past the cap so we can tell "exactly at the cap" from "more exist".
    const entries = await fetchAllEntries(client, t.tableName, recordLimit + 1);
    const capped = entries.length > recordLimit;
    const rows = entries.slice(0, recordLimit).map((e) => ({ key: e.key, value: e.value }));
    const file = join(dir, `${slugify(t.tableName) || 'table'}.json`);
    const capNote = capped
      ? colors.yellow(` (CAPPED at ${recordLimit} — table has more; raise --data-store-limit)`)
      : '';
    if (capped) truncated = true;
    if (dryRun) {
      console.error(
        `  ${colors.dim('(dry-run) would write')} ${file} ${
          colors.dim(`(${rows.length} entries)`)
        }${capNote}`,
      );
      continue;
    }
    await Deno.writeTextFile(file, JSON.stringify(rows, null, 2) + '\n');
    console.error(
      `  ${colors.green('✓')} ${t.tableName} ${colors.dim(`→ ${rows.length} entries`)}${capNote}`,
    );
  }
  // A capped table means this isn't a complete snapshot — flag it (but capping
  // is intentional, so it's a warning, not a hard failure).
  return truncated ? 'truncated' : 'ok';
}

export interface BackupOptions {
  dir?: string;
  apiUrl?: string;
  orgId?: string;
  force: boolean;
  dryRun: boolean;
  /** Mask connection/environment secrets as "***" instead of plaintext. */
  mask?: boolean;
  /** Include resources installed from packages (default: org-owned only). */
  includePackages?: boolean;
  /** Max records to export per data-store table (default 10000). Raise to capture huge tables. */
  dataStoreLimit?: number;
}

/** Default per-table record cap for data-store backups. */
const DEFAULT_DATA_STORE_LIMIT = 10_000;

export async function runBackup(opts: BackupOptions): Promise<void> {
  const { client, org } = await openSession(opts, 'backup');
  const root = resolve(opts.dir ?? (slugify(org.name) || org.suid || org.id));
  console.error(`  Root: ${root}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );
  if (!opts.mask) {
    console.error(
      colors.dim('  Secrets: plaintext (pass --mask to redact connection/env secrets)'),
    );
  }

  const common = {
    apiUrl: opts.apiUrl,
    orgId: opts.orgId,
    force: opts.force,
    dryRun: opts.dryRun,
  };
  const includePackages = opts.includePackages ?? false;
  const results: Array<{ resource: string; status: StepStatus; error?: string }> = [];

  const step = async (resource: string, fn: () => Promise<StepStatus | void>) => {
    console.error(`\n${colors.bold.cyan(`━━ ${resource} ━━`)}`);
    try {
      const status = (await fn()) || 'ok';
      results.push({ resource, status });
    } catch (e) {
      const error = (e as Error).message;
      console.error(`  ${colors.red('✗')} ${resource} failed: ${error}`);
      results.push({ resource, status: 'failed', error });
    }
  };

  await step(
    'workflows',
    () =>
      runWorkflowsPull({
        ...common,
        dir: join(root, 'workflows'),
        templates: 'all',
        includePackages,
      }),
  );
  await step(
    'connections',
    () => runConnectionsPull({ ...common, dir: join(root, 'connections'), mask: opts.mask }),
  );
  await step(
    'environments',
    () => runEnvironmentsPull({ ...common, dir: join(root, 'environments'), mask: opts.mask }),
  );
  await step(
    'triggers',
    () => runTriggersPull({ ...common, dir: join(root, 'triggers'), includePackages }),
  );
  const recordLimit = opts.dataStoreLimit ?? DEFAULT_DATA_STORE_LIMIT;
  await step(
    'data-stores',
    () => backupDataStores(client, join(root, 'data-stores'), opts.dryRun, recordLimit),
  );

  console.error('\n' + colors.bold('Backup summary') + colors.dim(` → ${root}`));
  for (const r of results) {
    const mark = r.status === 'ok'
      ? colors.green('✓')
      : r.status === 'skipped'
      ? colors.dim('•')
      : r.status === 'truncated'
      ? colors.yellow('!')
      : colors.red('✗');
    const label = r.status === 'skipped'
      ? colors.dim('skipped')
      : r.status === 'truncated'
      ? colors.yellow('truncated (raise --data-store-limit for a complete copy)')
      : r.status;
    console.error(`  ${mark} ${r.resource.padEnd(14)} ${label}`);
  }
  if (results.some((r) => r.status === 'failed')) Deno.exit(1);
}
