/**
 * `quickflo packages install <ref>` — install a package into the active org.
 *
 * `<ref>` auto-detects between three input shapes:
 *   1. Canonical address: `@orgSuid/localName` → resolves via
 *      `GET /packages/resolve/@:orgSuid/:localName`, then preview + commit.
 *      Append `@<semver>` (e.g. `@acme/onboarding@1.2.0`) to pin a specific
 *      published version; otherwise resolves to the latest.
 *   2. Unlisted-install token: starts with `qfi_` → resolves via
 *      `GET /packages/install/u/:token`, then preview + commit.
 *   3. Local `.qfpkg.zip` (or legacy `.qfpkg`) file: existing path or string
 *      ending in either extension → multipart upload to
 *      `/packages/install/preview-from-artifact` + `/commit-from-artifact`.
 *
 * V1 ships with author-default decisions (`{ aliases: [], workflowAttachedEnvs: {},
 * sharedEnvValuesToCreate: {} }`). Power users can override via
 * `--decisions <file.json>` matching `CommitDecisions` shape.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve as resolvePath } from '@std/path';
import { type ApiClient } from './api.ts';
import { openSession } from './session.ts';
import {
  isUnlistedToken,
  type PackageRow,
  type PackageVersionRow,
  parseCanonicalRef,
  resolveCanonical as resolveCanonicalShared,
  resolveUnlistedToken as resolveUnlistedTokenShared,
} from './packages-refs.ts';

interface CommitDecisions {
  aliases: unknown[];
  workflowAttachedEnvs: Record<string, unknown>;
  sharedEnvValuesToCreate: Record<string, string>;
  seedDataStoreRowsFor?: Record<string, boolean>;
}

interface InstallPreview {
  packageSummary: {
    slug: string;
    name: string;
    version: string;
    description?: string;
    summary?: string;
  };
  resources: ReadonlyArray<{ kind: string; name: string }>;
  peerDepDecisions: ReadonlyArray<{ kind: string }>;
  setupChecklistPreview: ReadonlyArray<{ kind: string; label: string }>;
  collisions: ReadonlyArray<{ kind: string; name: string }>;
}

interface InstallCommitResult {
  packageInstallId: string;
  installedResources: ReadonlyArray<{
    kind: string;
    id: string;
    name: string;
    didCreate: boolean;
  }>;
  setupChecklist: ReadonlyArray<{
    id: string;
    kind: string;
    label: string;
  }>;
}

type RefShape =
  | {
    kind: 'canonical';
    orgSuid: string;
    localName: string;
    /** Pinned semver from `@org/name@version`. Falls back to latest when absent. */
    version?: string;
  }
  | { kind: 'token'; token: string }
  | { kind: 'file'; path: string };

async function detectRef(ref: string): Promise<RefShape> {
  if (isUnlistedToken(ref)) {
    return { kind: 'token', token: ref };
  }
  const canonical = parseCanonicalRef(ref);
  if (canonical) {
    return {
      kind: 'canonical',
      orgSuid: canonical.orgSuid,
      localName: canonical.localName,
      ...(canonical.version ? { version: canonical.version } : {}),
    };
  }
  // Treat anything that smells like a path as a file ref. Accept both the
  // canonical `.qfpkg.zip` extension and the legacy `.qfpkg` for older
  // downloads still floating around.
  if (
    ref.endsWith('.qfpkg.zip') ||
    ref.endsWith('.qfpkg') ||
    ref.startsWith('./') ||
    ref.startsWith('/')
  ) {
    const path = resolvePath(ref);
    try {
      const stat = await Deno.stat(path);
      if (!stat.isFile) {
        throw new Error(`"${ref}" is not a file`);
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        throw new Error(`File not found: ${ref}`);
      }
      throw e;
    }
    return { kind: 'file', path };
  }
  throw new Error(
    `Unrecognized ref "${ref}". Expected @orgSuid/name (canonical), qfi_… (unlisted token), or path to a .qfpkg.zip file.`,
  );
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

async function resolveCanonicalForInstall(
  client: ApiClient,
  orgSuid: string,
  localName: string,
  pinnedVersion?: string,
): Promise<{ pkg: PackageRow; version: PackageVersionRow }> {
  const { pkg, latestVersion } = await resolveCanonicalShared(
    client,
    orgSuid,
    localName,
  );
  if (!pinnedVersion) {
    if (!latestVersion) {
      throw new Error(
        `Package @${orgSuid}/${localName} has no published versions yet.`,
      );
    }
    return { pkg, version: latestVersion };
  }
  // Pinned: chain a getVersion lookup against the resolved package id. Two
  // round-trips by design — the canonical resolver returns latest only, and
  // adding a version-aware variant doubles the API surface for a path that
  // 99% of installs (latest) don't take.
  const versionRes = await fetch(
    `${client.apiUrl}/packages/${encodeURIComponent(pkg.id)}/versions/${
      encodeURIComponent(pinnedVersion)
    }`,
    {
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        'x-organization-id': client.orgId,
      },
    },
  );
  if (!versionRes.ok) {
    if (versionRes.status === 404) {
      throw new Error(
        `Package @${orgSuid}/${localName} has no version "${pinnedVersion}". ` +
          `Run \`quickflo packages list-versions @${orgSuid}/${localName}\` to see what's published.`,
      );
    }
    const text = await versionRes.text().catch(() => '');
    throw new Error(
      `Version lookup failed (${versionRes.status}): ${text || versionRes.statusText}`,
    );
  }
  const version = (await versionRes.json()) as PackageVersionRow;
  return { pkg, version };
}

async function previewFromRegistry(
  client: ApiClient,
  packageId: string,
  packageVersionId: string,
): Promise<InstallPreview> {
  const res = await fetch(`${client.apiUrl}/packages/install/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.accessToken}`,
      'x-organization-id': client.orgId,
    },
    body: JSON.stringify({ packageId, packageVersionId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Preview failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return (await res.json()) as InstallPreview;
}

async function commitFromRegistry(
  client: ApiClient,
  packageId: string,
  packageVersionId: string,
  decisions: CommitDecisions,
): Promise<InstallCommitResult> {
  const res = await fetch(`${client.apiUrl}/packages/install`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.accessToken}`,
      'x-organization-id': client.orgId,
    },
    body: JSON.stringify({ packageId, packageVersionId, decisions }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Commit failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as InstallCommitResult;
}

async function previewFromFile(
  client: ApiClient,
  path: string,
): Promise<InstallPreview> {
  const bytes = await Deno.readFile(path);
  const form = new FormData();
  form.append(
    'artifact',
    new Blob([bytes], { type: 'application/zip' }),
    path.split('/').pop() ?? 'package.qfpkg.zip',
  );
  const res = await fetch(
    `${client.apiUrl}/packages/install/preview-from-artifact`,
    {
      method: 'POST',
      headers: {
        // Don't set Content-Type — fetch derives multipart boundary from
        // the FormData body. Manually setting it breaks parsing server-side.
        Authorization: `Bearer ${client.accessToken}`,
        'x-organization-id': client.orgId,
      },
      body: form,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Preview-from-artifact failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return (await res.json()) as InstallPreview;
}

async function commitFromFile(
  client: ApiClient,
  path: string,
  slug: string,
  version: string,
  decisions: CommitDecisions,
): Promise<InstallCommitResult> {
  const bytes = await Deno.readFile(path);
  const form = new FormData();
  form.append(
    'artifact',
    new Blob([bytes], { type: 'application/zip' }),
    path.split('/').pop() ?? 'package.qfpkg.zip',
  );
  form.append('slug', slug);
  form.append('version', version);
  form.append('decisions', JSON.stringify(decisions));
  const res = await fetch(
    `${client.apiUrl}/packages/install/commit-from-artifact`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        'x-organization-id': client.orgId,
      },
      body: form,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Commit-from-artifact failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return (await res.json()) as InstallCommitResult;
}

function printPreview(preview: InstallPreview): void {
  const s = preview.packageSummary;
  console.error('');
  console.error(
    `${colors.bold(s.name)} ${colors.dim(`${s.slug}@${s.version}`)}`,
  );
  if (s.summary) console.error(`  ${colors.dim(s.summary)}`);
  if (s.description) console.error(`  ${colors.dim(s.description)}`);
  console.error('');
  console.error(
    `  Resources: ${colors.bold(String(preview.resources.length))} (${
      groupCount(
        preview.resources.map((r) => r.kind),
      )
    })`,
  );
  console.error(
    `  Peer-deps: ${colors.bold(String(preview.peerDepDecisions.length))} (${
      groupCount(
        preview.peerDepDecisions.map((d) => d.kind),
      )
    })`,
  );
  console.error(
    `  Setup todos: ${colors.bold(String(preview.setupChecklistPreview.length))}`,
  );
  if (preview.collisions.length > 0) {
    console.error(
      `  ${
        colors.yellow('!')
      } Name collisions with existing user-owned resources: ${preview.collisions.length}`,
    );
    for (const c of preview.collisions) {
      console.error(`    - ${c.kind} "${c.name}"`);
    }
  }
}

function printCommitResult(result: InstallCommitResult): void {
  console.error('');
  console.error(
    `${colors.green('✓')} Installed (${colors.dim(`PackageInstall ${result.packageInstallId}`)})`,
  );
  const created = result.installedResources.filter((r) => r.didCreate).length;
  const reused = result.installedResources.length - created;
  console.error(
    `  Resources: ${colors.green(`${created} created`)}, ${reused} bound`,
  );
  if (result.setupChecklist.length > 0) {
    console.error(
      `  ${
        colors.yellow('!')
      } ${result.setupChecklist.length} setup todo(s) — open in the UI to complete:`,
    );
    for (const t of result.setupChecklist) {
      console.error(`    - [${t.kind}] ${t.label}`);
    }
  }
}

function groupCount(kinds: string[]): string {
  if (kinds.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
}

export interface PackagesInstallOptions {
  ref: string;
  apiUrl?: string;
  orgId?: string;
  dryRun?: boolean;
  decisionsFile?: string;
  json?: boolean;
}

export async function runPackagesInstall(
  opts: PackagesInstallOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'packages install');
  console.error(
    colors.dim(`\nTarget org: ${org.name} (${org.suid ?? org.id})`),
  );

  const ref = await detectRef(opts.ref);
  const decisions = opts.decisionsFile
    ? await readDecisionsFile(opts.decisionsFile)
    : defaultDecisions();

  if (ref.kind === 'file') {
    console.error(
      colors.dim(`Ref: file ${colors.bold(ref.path.split('/').pop() ?? ref.path)}`),
    );
    const preview = await previewFromFile(client, ref.path);
    printPreview(preview);
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify(preview, null, 2));
      return;
    }
    const result = await commitFromFile(
      client,
      ref.path,
      preview.packageSummary.slug,
      preview.packageSummary.version,
      decisions,
    );
    printCommitResult(result);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    return;
  }

  let pkg: PackageRow;
  let version: PackageVersionRow;
  if (ref.kind === 'canonical') {
    const display = ref.version
      ? `@${ref.orgSuid}/${ref.localName}@${ref.version}`
      : `@${ref.orgSuid}/${ref.localName}`;
    console.error(colors.dim(`Ref: canonical ${colors.bold(display)}`));
    ({ pkg, version } = await resolveCanonicalForInstall(
      client,
      ref.orgSuid,
      ref.localName,
      ref.version,
    ));
  } else {
    console.error(colors.dim(`Ref: unlisted token ${colors.bold(ref.token.slice(0, 8) + '…')}`));
    ({ pkg, version } = await resolveUnlistedTokenShared(client, ref.token));
  }

  const preview = await previewFromRegistry(client, pkg.id, version.id);
  printPreview(preview);
  if (opts.dryRun) {
    if (opts.json) console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const result = await commitFromRegistry(client, pkg.id, version.id, decisions);
  printCommitResult(result);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
}
