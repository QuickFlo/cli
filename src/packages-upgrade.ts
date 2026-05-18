/**
 * `quickflo packages upgrade <install-id> --to <version>` — preview a
 * reinstall and (with `--apply`) commit it.
 *
 * Two-step like `terraform plan` / `terraform apply`:
 *   1. POST /package-installs/:id/reinstall/preview → render the diff
 *   2. (with `--apply`) POST /package-installs/:id/reinstall → commit
 *
 * Reinstall is destructive enough — workflows may be added, replaced, or
 * removed — that the user sees the diff first and opts in to commit.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve as resolvePath } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';

interface PackageInstallRow {
  id: string;
  packageId: string;
  packageVersionId: string;
}

interface PackageInstallListResponse {
  data: PackageInstallRow[];
}

interface PackageVersionRow {
  id: string;
  packageId: string;
  version: string;
}

interface ReinstallPreview {
  fromVersion: string;
  toVersion: string;
  diff: ReadonlyArray<{ kind: string; name: string; change: string }>;
  peerDepDecisions: ReadonlyArray<{ kind: string; name?: string }>;
  sharedEnvKeys: ReadonlyArray<string>;
  currentBindings: Record<string, unknown>;
  invalidAliases: ReadonlyArray<{ kind: string; name: string; reason?: string }>;
}

interface ReinstallCommitResult {
  resourceChanges: ReadonlyArray<{ kind: string; name: string; change: string }>;
  installedResources: ReadonlyArray<{
    kind: string;
    id: string;
    name: string;
    didCreate: boolean;
  }>;
  setupChecklist: ReadonlyArray<{ id: string; kind: string; label: string }>;
}

interface CommitDecisions {
  aliases: unknown[];
  workflowAttachedEnvs: Record<string, unknown>;
  sharedEnvValuesToCreate: Record<string, string>;
  seedDataStoreRowsFor?: Record<string, boolean>;
}

function defaultDecisions(): CommitDecisions {
  return {
    aliases: [],
    workflowAttachedEnvs: {},
    sharedEnvValuesToCreate: {},
  };
}

async function readDecisionsFile(path: string): Promise<CommitDecisions> {
  const raw = await Deno.readTextFile(resolvePath(path));
  const parsed = JSON.parse(raw) as Partial<CommitDecisions>;
  return {
    aliases: parsed.aliases ?? [],
    workflowAttachedEnvs: parsed.workflowAttachedEnvs ?? {},
    sharedEnvValuesToCreate: parsed.sharedEnvValuesToCreate ?? {},
    ...(parsed.seedDataStoreRowsFor !== undefined
      ? { seedDataStoreRowsFor: parsed.seedDataStoreRowsFor }
      : {}),
  };
}

async function fetchInstall(
  client: ApiClient,
  installId: string,
): Promise<PackageInstallRow> {
  // /package-installs/:id may not exist as a GET (the controller only
  // exposes list + delete). Use the list endpoint with where[id] for a
  // single-row lookup — same trick `resolveInstallAddresses` uses.
  const params = new URLSearchParams();
  params.set('where[id][$eq]', installId);
  params.set('options[limit]', '1');
  const res = await apiFetch<PackageInstallListResponse>(
    client,
    `/package-installs?${params.toString()}`,
  );
  const row = res.data?.[0];
  if (!row) throw new Error(`Package install "${installId}" not found.`);
  return row;
}

async function resolveVersion(
  client: ApiClient,
  packageId: string,
  version: string,
): Promise<PackageVersionRow> {
  const res = await fetch(
    `${client.apiUrl}/packages/${encodeURIComponent(packageId)}/versions/${
      encodeURIComponent(version)
    }`,
    {
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        'x-organization-id': client.orgId,
      },
    },
  );
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `Package has no version "${version}". Run \`quickflo packages list-versions <@org/name>\` to see what's published.`,
      );
    }
    const text = await res.text().catch(() => '');
    throw new Error(
      `Version lookup failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return (await res.json()) as PackageVersionRow;
}

function printPreview(p: ReinstallPreview): void {
  console.error('');
  console.error(
    `${colors.bold('Upgrade')} ${colors.dim(p.fromVersion)} → ${colors.bold(p.toVersion)}`,
  );
  console.error('');
  if (p.diff.length === 0) {
    console.error(`  ${colors.dim('(no resource changes)')}`);
  } else {
    console.error(`  Resource changes: ${colors.bold(String(p.diff.length))}`);
    for (const d of p.diff) {
      console.error(`    ${formatChange(d.change)} [${d.kind}] ${d.name}`);
    }
  }
  if (p.peerDepDecisions.length > 0) {
    console.error(
      `  Peer-deps: ${
        colors.bold(String(p.peerDepDecisions.length))
      } (pass --decisions <file> to override defaults)`,
    );
  }
  if (p.sharedEnvKeys.length > 0) {
    console.error(
      `  Shared env keys: ${p.sharedEnvKeys.length} (${p.sharedEnvKeys.slice(0, 5).join(', ')}${
        p.sharedEnvKeys.length > 5 ? `, +${p.sharedEnvKeys.length - 5}` : ''
      })`,
    );
  }
  if (p.invalidAliases.length > 0) {
    console.error(
      `  ${colors.yellow('!')} ${p.invalidAliases.length} invalid alias(es):`,
    );
    for (const a of p.invalidAliases) {
      console.error(`    - [${a.kind}] ${a.name}${a.reason ? `: ${a.reason}` : ''}`);
    }
  }
}

function formatChange(c: string): string {
  if (c === 'added' || c === 'create') return colors.green('+');
  if (c === 'removed' || c === 'delete') return colors.red('-');
  if (c === 'replaced' || c === 'update') return colors.yellow('~');
  return '·';
}

function printCommitResult(r: ReinstallCommitResult): void {
  console.error('');
  console.error(`${colors.green('✓')} Reinstalled`);
  const created = r.installedResources.filter((x) => x.didCreate).length;
  const reused = r.installedResources.length - created;
  console.error(
    `  Resources: ${colors.green(`${created} created`)}, ${reused} bound`,
  );
  if (r.setupChecklist.length > 0) {
    console.error(
      `  ${colors.yellow('!')} ${r.setupChecklist.length} setup todo(s):`,
    );
    for (const t of r.setupChecklist) {
      console.error(`    - [${t.kind}] ${t.label}`);
    }
  }
}

export interface PackagesUpgradeOptions {
  installId: string;
  to: string;
  apply?: boolean;
  decisionsFile?: string;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runPackagesUpgrade(
  opts: PackagesUpgradeOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'packages upgrade');
  const install = await fetchInstall(client, opts.installId);
  const target = await resolveVersion(client, install.packageId, opts.to);

  const preview = await apiFetch<ReinstallPreview>(
    client,
    `/package-installs/${encodeURIComponent(install.id)}/reinstall/preview`,
    {
      method: 'POST',
      body: JSON.stringify({ incomingPackageVersionId: target.id }),
    },
  );
  printPreview(preview);

  if (!opts.apply) {
    console.error('');
    console.error(
      colors.dim('Preview only. Re-run with --apply to commit.'),
    );
    if (opts.json) console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const decisions = opts.decisionsFile
    ? await readDecisionsFile(opts.decisionsFile)
    : defaultDecisions();

  const result = await apiFetch<ReinstallCommitResult>(
    client,
    `/package-installs/${encodeURIComponent(install.id)}/reinstall`,
    {
      method: 'POST',
      body: JSON.stringify({
        incomingPackageVersionId: target.id,
        decisions,
      }),
    },
  );
  printCommitResult(result);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
}
