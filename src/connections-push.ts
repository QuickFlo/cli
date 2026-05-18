/**
 * `quickflo connections push` — bulk-upsert connection JSON files into an
 * organization. Upsert key is `name` (unique per org). Files containing
 * literal `"***"` placeholders from a masked pull are rejected up front —
 * pushing those would wipe the real config server-side.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { listOAuthProviders } from './connections-oauth.ts';
import { openSession } from './session.ts';

interface ConnectionFile {
  id?: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ExistingConnection {
  id: string;
  name: string;
}

interface ConnectionListResponse {
  data: ExistingConnection[];
}

function containsMaskedSecret(config: Record<string, unknown>): boolean {
  for (const v of Object.values(config)) {
    if (v === '***') return true;
  }
  return false;
}

async function findByName(
  client: ApiClient,
  name: string,
): Promise<ExistingConnection | null> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[name][$eq]', name);
  params.set('options[limit]', '1');
  const res = await apiFetch<ConnectionListResponse>(
    client,
    `/connections?${params.toString()}`,
  );
  return res.data?.[0] ?? null;
}

function buildPayload(def: ConnectionFile): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: def.name,
    type: def.type,
    config: def.config,
  };
  if (def.settings !== undefined) body['settings'] = def.settings;
  return body;
}

function createConnection(
  client: ApiClient,
  def: ConnectionFile,
): Promise<ExistingConnection> {
  return apiFetch<ExistingConnection>(client, `/connections`, {
    method: 'POST',
    body: JSON.stringify({
      ...buildPayload(def),
      organizationId: client.orgId,
    }),
  });
}

function updateConnection(
  client: ApiClient,
  id: string,
  def: ConnectionFile,
): Promise<ExistingConnection> {
  return apiFetch<ExistingConnection>(client, `/connections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(buildPayload(def)),
  });
}

export interface ConnectionsPushOptions {
  dir: string;
  apiUrl?: string;
  orgId?: string;
  dryRun: boolean;
}

export async function runConnectionsPush(
  opts: ConnectionsPushOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'connections push');
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

  const providers = await listOAuthProviders(client);
  const oauthTypes = new Set(providers.map((p) => p.id));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const filePath of files) {
    const filename = filePath.split('/').pop() || filePath;
    if (filename === '_skipped_oauth.json') continue;
    console.error(`\n${colors.bold(`[${filename}]`)}`);
    let def: ConnectionFile;
    try {
      def = JSON.parse(await Deno.readTextFile(filePath)) as ConnectionFile;
      if (!def.name) throw new Error(`missing 'name'`);
      if (!def.type) throw new Error(`missing 'type'`);
      if (!def.config || typeof def.config !== 'object') {
        throw new Error(`missing 'config' object`);
      }
      if (containsMaskedSecret(def.config)) {
        throw new Error(
          `config contains "***" placeholders — pull without --mask to get the real values before pushing`,
        );
      }
    } catch (e) {
      console.error(`  ${colors.red('✗')} ${(e as Error).message}`);
      failed++;
      continue;
    }

    if (oauthTypes.has(def.type)) {
      console.error(
        `  ${
          colors.dim('•')
        } skipped OAuth-typed connection "${def.name}" (${def.type}) — use \`quickflo connections create --type ${def.type} --name "${def.name}"\``,
      );
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      console.error(`  ${colors.dim('(dry-run) would upsert connection')}`);
      skipped++;
      continue;
    }

    try {
      const existing = await findByName(client, def.name);
      if (existing) {
        await updateConnection(client, existing.id, def);
        console.error(
          `  ${colors.green('✓')} updated connection ${colors.dim(existing.id)}`,
        );
        updated++;
      } else {
        const created_ = await createConnection(client, def);
        console.error(
          `  ${colors.green('✓')} created connection ${colors.dim(created_.id)}`,
        );
        created++;
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
