/**
 * `quickflo environments push` — upsert environments + their variables from
 * a directory of JSON files. Env upsert key is `name` (unique per org);
 * variables are bulk-upserted via PATCH /:id/variables. `--prune` extends to
 * deleting remote variables not present in the file (bulk-delete).
 *
 * Files containing `"***"` placeholder values are rejected up front — pushing
 * those would wipe real secret values server-side.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { fetchVariableKeys } from './environments-get.ts';
import { openSession } from './session.ts';

interface EnvironmentFile {
  id?: string;
  name: string;
  variables: Record<string, string>;
}

interface ExistingEnvironment {
  id: string;
  name: string;
}

interface EnvironmentListResponse {
  data: ExistingEnvironment[];
}

function containsMaskedSecret(vars: Record<string, string>): boolean {
  for (const v of Object.values(vars)) if (v === '***') return true;
  return false;
}

async function findByName(
  client: ApiClient,
  name: string,
): Promise<ExistingEnvironment | null> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[name][$eq]', name);
  params.set('options[limit]', '1');
  const res = await apiFetch<EnvironmentListResponse>(
    client,
    `/environments?${params.toString()}`,
  );
  return res.data?.[0] ?? null;
}

function createEnvironment(
  client: ApiClient,
  def: EnvironmentFile,
): Promise<ExistingEnvironment> {
  const variables = Object.entries(def.variables).map(([key, value]) => ({ key, value }));
  return apiFetch<ExistingEnvironment>(client, `/environments`, {
    method: 'POST',
    body: JSON.stringify({
      name: def.name,
      organizationId: client.orgId,
      variables,
    }),
  });
}

function bulkUpsertVariables(
  client: ApiClient,
  id: string,
  vars: Record<string, string>,
): Promise<unknown> {
  const variables = Object.entries(vars).map(([key, value]) => ({ key, value }));
  return apiFetch(client, `/environments/${id}/variables`, {
    method: 'PATCH',
    body: JSON.stringify({ variables }),
  });
}

function bulkDeleteVariables(
  client: ApiClient,
  id: string,
  keys: string[],
): Promise<unknown> {
  return apiFetch(client, `/environments/${id}/variables/bulk-delete`, {
    method: 'POST',
    body: JSON.stringify({ keys }),
  });
}

export interface EnvironmentsPushOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  dryRun: boolean;
  /** Delete remote vars not present in the file. */
  prune?: boolean;
}

export async function runEnvironmentsPush(
  opts: EnvironmentsPushOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'environments push');
  const dir = resolve(opts.dir);
  console.error(`  Dir:  ${dir}`);
  console.error(
    `  Mode: ${opts.dryRun ? colors.yellow('DRY RUN') : colors.green('LIVE')}`,
  );
  if (opts.prune) console.error(`  ${colors.yellow('Prune: remote-only vars will be deleted')}`);

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

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const filePath of files) {
    const filename = filePath.split('/').pop() || filePath;
    console.error(`\n${colors.bold(`[${filename}]`)}`);
    let def: EnvironmentFile;
    try {
      def = JSON.parse(await Deno.readTextFile(filePath)) as EnvironmentFile;
      if (!def.name) throw new Error(`missing 'name'`);
      if (!def.variables || typeof def.variables !== 'object') {
        throw new Error(`missing 'variables' object`);
      }
      if (containsMaskedSecret(def.variables)) {
        throw new Error(
          `variables contain "***" placeholders — pull without --mask before pushing`,
        );
      }
    } catch (e) {
      console.error(`  ${colors.red('✗')} ${(e as Error).message}`);
      failed++;
      continue;
    }

    if (opts.dryRun) {
      const action = opts.prune ? 'upsert + prune' : 'upsert';
      console.error(`  ${colors.dim(`(dry-run) would ${action}`)}`);
      skipped++;
      continue;
    }

    try {
      const existing = await findByName(client, def.name);
      let env: ExistingEnvironment;
      if (existing) {
        env = existing;
        await bulkUpsertVariables(client, env.id, def.variables);
        console.error(
          `  ${colors.green('✓')} updated environment ${colors.dim(env.id)} (${
            Object.keys(def.variables).length
          } vars)`,
        );
        updated++;
      } else {
        env = await createEnvironment(client, def);
        console.error(
          `  ${colors.green('✓')} created environment ${colors.dim(env.id)} (${
            Object.keys(def.variables).length
          } vars)`,
        );
        created++;
      }
      if (opts.prune) {
        const remoteKeys = await fetchVariableKeys(client, env.id);
        const localKeys = new Set(Object.keys(def.variables));
        const stale = remoteKeys.filter((k) => !localKeys.has(k));
        if (stale.length > 0) {
          await bulkDeleteVariables(client, env.id, stale);
          console.error(
            `  ${colors.yellow('•')} pruned ${stale.length} remote-only var(s): ${
              stale.slice(0, 5).join(', ')
            }${stale.length > 5 ? ` (+${stale.length - 5})` : ''}`,
          );
        }
      }
    } catch (e) {
      console.error(`  ${colors.red('✗')} ${(e as Error).message}`);
      failed++;
    }
  }

  console.error('\n' + colors.bold('Summary'));
  console.error(
    `  ${colors.green(`${created} created`)}, ${
      colors.yellow(`${updated} updated`)
    }, ${skipped} skipped, ${failed > 0 ? colors.red(`${failed} failed`) : `${failed} failed`}`,
  );
  if (failed > 0) Deno.exit(1);
}
