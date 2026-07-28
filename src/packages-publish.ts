/**
 * `quickflo packages publish` — publish a new version of a package.
 *
 * The server owns artifact assembly: caller supplies root *references*
 * (workflowTemplateId, triggerId, tableName, dashboardId) and metadata,
 * server fetches the underlying entities, walks the dependency graph, and
 * uploads the resulting `.qfpkg` to platform storage.
 *
 * Two ways to specify the publish:
 *   1. `--descriptor <file.json>` carrying the full body (matches the
 *      `PublishPackageVersionDto` schema) — best for version-controlled
 *      release definitions.
 *   2. CLI flags: `--root <kind>:<value>` (repeatable), `--version`,
 *      plus optional `--summary`, `--description`, `--readme`, `--changelog`,
 *      `--tags`, `--icon`. Good for ad-hoc publishes.
 *
 * Flags override descriptor fields when both are supplied.
 *
 * If `--package <slug>` is given and the package doesn't exist for the org,
 * the command creates it first (requires `--name` + `--visibility`) before
 * publishing the first version.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve as resolvePath } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';

type PublishRoot =
  | { kind: 'workflow' | 'sub-workflow'; workflowTemplateId: string }
  | { kind: 'trigger'; triggerId: string }
  | {
    kind: 'data-store-table';
    tableName: string;
    includeSeedRows?: boolean;
    seedRowLimit?: number;
  }
  | { kind: 'dashboard'; dashboardId: string };

type Visibility = 'public' | 'unlisted' | 'private';

interface PackageRow {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  visibility: Visibility;
}

interface PackageVersionRow {
  id: string;
  packageId: string;
  version: string;
  artifactUrl?: string;
  artifactDigest?: string;
  unlistedInstallToken?: string;
}

interface PublishVersionResponse {
  packageVersion: PackageVersionRow;
  manifest: { slug: string; version: string; resources: unknown[] };
  artifactBytes: number;
  artifactDigest: string;
  artifactUrl: string;
}

interface PublishDescriptor {
  package?: { slug?: string; name?: string; visibility?: Visibility };
  version: string;
  summary?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  roots: PublishRoot[];
  extensionPoints?: unknown[];
  sharedEnvDefaults?: { include: string[] };
  descriptions?: {
    connections?: Record<string, string>;
    envs?: Record<string, string>;
    dataStoreTables?: Record<string, string>;
  };
  optionalEnvKeys?: string[];
  readme?: string;
  changelog?: string;
}

const ROOT_KINDS = new Set([
  'workflow',
  'sub-workflow',
  'trigger',
  'data-store-table',
  'dashboard',
]);

function parseRootFlag(expr: string): PublishRoot {
  const [kind, ...rest] = expr.split(':');
  if (!ROOT_KINDS.has(kind)) {
    throw new Error(
      `Invalid --root "${expr}": kind must be one of ${[...ROOT_KINDS].join(', ')}`,
    );
  }
  const value = rest.join(':');
  if (!value) {
    throw new Error(`Invalid --root "${expr}": missing id/name`);
  }
  switch (kind) {
    case 'workflow':
    case 'sub-workflow':
      return { kind, workflowTemplateId: value };
    case 'trigger':
      return { kind: 'trigger', triggerId: value };
    case 'data-store-table':
      return { kind: 'data-store-table', tableName: value };
    case 'dashboard':
      return { kind: 'dashboard', dashboardId: value };
    default:
      throw new Error(`Unreachable: kind=${kind}`);
  }
}

async function readDescriptor(path: string): Promise<PublishDescriptor> {
  const raw = await Deno.readTextFile(resolvePath(path));
  return JSON.parse(raw) as PublishDescriptor;
}

async function maybeReadFile(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  return await Deno.readTextFile(resolvePath(path));
}

async function findPackageBySlug(
  client: ApiClient,
  slug: string,
): Promise<PackageRow | null> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[slug][$eq]', slug);
  params.set('options[limit]', '1');
  const res = await apiFetch<{ data: PackageRow[]; total: number }>(
    client,
    `/packages?${params.toString()}`,
  );
  return res.data?.[0] ?? null;
}

async function getPackageById(
  client: ApiClient,
  id: string,
): Promise<PackageRow | null> {
  try {
    return await apiFetch<PackageRow>(client, `/packages/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

function createPackage(
  client: ApiClient,
  body: {
    slug: string;
    name: string;
    visibility: Visibility;
    description?: string;
    icon?: string;
    tags?: string[];
  },
): Promise<PackageRow> {
  return apiFetch<PackageRow>(client, '/packages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function publishVersion(
  client: ApiClient,
  packageId: string,
  body: Omit<PublishDescriptor, 'package'>,
): Promise<PublishVersionResponse> {
  return apiFetch<PublishVersionResponse>(
    client,
    `/packages/${encodeURIComponent(packageId)}/versions`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public packages require the canonical `@<orgSuid>/<name>` slug, and the
 * server only enforces that on the private→public transition — so a bare
 * slug written at auto-create produces a package that can never go public.
 * Canonicalize here, where the org is known.
 */
export function canonicalizeSlug(ref: string, orgSuid: string | undefined): string {
  if (ref.startsWith('@')) {
    const [owner, ...rest] = ref.slice(1).split('/');
    if (!owner || rest.length !== 1 || !rest[0]) {
      throw new Error(
        `Invalid package slug "${ref}" — expected "@<org>/<package-name>"`,
      );
    }
    if (orgSuid && owner !== orgSuid) {
      throw new Error(
        `Slug "${ref}" doesn't belong to the authenticated org — the canonical slug for this org is "@${orgSuid}/${
          rest[0]
        }"`,
      );
    }
    return ref;
  }
  if (!orgSuid) {
    throw new Error(
      `Cannot derive the canonical slug for "${ref}": the authenticated org has no suid. Pass the full "@<org>/${ref}" slug instead.`,
    );
  }
  return `@${orgSuid}/${ref}`;
}

export interface PackagesPublishOptions {
  packageRef: string;
  apiUrl?: string;
  orgId?: string;
  descriptor?: string;
  version?: string;
  summary?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  roots?: string[];
  readmeFile?: string;
  changelogFile?: string;
  /** For first-publish auto-create. */
  name?: string;
  visibility?: Visibility;
  dryRun?: boolean;
  json?: boolean;
}

export async function runPackagesPublish(
  opts: PackagesPublishOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'packages publish');
  console.error(
    colors.dim(`\nAuthor org: ${org.name} (${org.suid ?? org.id})`),
  );

  const descriptor: PublishDescriptor | null = opts.descriptor
    ? await readDescriptor(opts.descriptor)
    : null;

  // Merge: CLI flags override descriptor.
  const version = opts.version ?? descriptor?.version;
  if (!version) {
    throw new Error('--version is required (or set "version" in --descriptor file)');
  }

  const cliRoots = (opts.roots ?? []).map(parseRootFlag);
  const roots = cliRoots.length > 0 ? cliRoots : descriptor?.roots ?? [];
  if (roots.length === 0) {
    throw new Error(
      'At least one --root <kind>:<value> is required (or "roots" in --descriptor)',
    );
  }

  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : descriptor?.tags;
  const summary = opts.summary ?? descriptor?.summary;
  const description = opts.description ?? descriptor?.description;
  const icon = opts.icon ?? descriptor?.icon;
  const readme = (await maybeReadFile(opts.readmeFile)) ?? descriptor?.readme;
  const changelog = (await maybeReadFile(opts.changelogFile)) ?? descriptor?.changelog;

  // Resolve the target Package row — find by id or slug, or create.
  let pkg: PackageRow | null;
  let createSlug: string | null = null;
  if (UUID_RE.test(opts.packageRef)) {
    pkg = await getPackageById(client, opts.packageRef);
    if (!pkg) {
      throw new Error(`Package id "${opts.packageRef}" not found`);
    }
  } else {
    pkg = await findPackageBySlug(client, opts.packageRef);
    if (!pkg) {
      // Bare refs (e.g. `lead-gen`) may point at a package stored under its
      // canonical slug — retry the lookup before deciding to auto-create.
      createSlug = canonicalizeSlug(opts.packageRef, org.suid);
      if (createSlug !== opts.packageRef) {
        pkg = await findPackageBySlug(client, createSlug);
      }
    }
    if (!pkg) {
      const name = opts.name ?? descriptor?.package?.name;
      const visibility = opts.visibility ?? descriptor?.package?.visibility ?? 'private';
      if (!name) {
        throw new Error(
          `Package "${opts.packageRef}" doesn't exist for this org. Pass --name (and optionally --visibility) to create it on first publish.`,
        );
      }
      console.error(
        colors.dim(
          `\nPackage "${opts.packageRef}" not found — creating as ${
            colors.bold(createSlug!)
          } with visibility=${visibility}`,
        ),
      );
      if (opts.dryRun) {
        console.error(colors.yellow(`[dry-run] would create package ${createSlug}`));
      } else {
        pkg = await createPackage(client, {
          slug: createSlug!,
          name,
          visibility,
          ...(description !== undefined ? { description } : {}),
          ...(icon !== undefined ? { icon } : {}),
          ...(tags !== undefined ? { tags } : {}),
        });
        console.error(
          colors.green(`✓ Created package ${colors.bold(pkg.slug)} ${colors.dim(pkg.id)}`),
        );
      }
    }
  }

  console.error('');
  console.error(
    `Publishing ${colors.bold(pkg?.slug ?? createSlug ?? opts.packageRef)}@${colors.cyan(version)}`,
  );
  console.error(`  Roots: ${roots.length}`);
  for (const r of roots) {
    if (r.kind === 'workflow' || r.kind === 'sub-workflow') {
      console.error(`    - ${r.kind}: ${r.workflowTemplateId}`);
    } else if (r.kind === 'trigger') {
      console.error(`    - trigger: ${r.triggerId}`);
    } else if (r.kind === 'data-store-table') {
      console.error(`    - data-store-table: ${r.tableName}`);
    } else if (r.kind === 'dashboard') {
      console.error(`    - dashboard: ${r.dashboardId}`);
    }
  }
  if (summary) console.error(`  Summary: ${summary}`);

  if (opts.dryRun) {
    console.error(colors.yellow('\n[dry-run] would POST /packages/:id/versions'));
    return;
  }

  if (!pkg) {
    // Unreachable in non-dry-run: we either resolved or created above. Guard
    // for the type narrowing.
    throw new Error('Package not resolved — internal CLI error');
  }

  const body: Omit<PublishDescriptor, 'package'> = {
    version,
    roots,
    ...(summary !== undefined ? { summary } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(descriptor?.extensionPoints ? { extensionPoints: descriptor.extensionPoints } : {}),
    ...(descriptor?.sharedEnvDefaults ? { sharedEnvDefaults: descriptor.sharedEnvDefaults } : {}),
    ...(descriptor?.descriptions ? { descriptions: descriptor.descriptions } : {}),
    ...(descriptor?.optionalEnvKeys ? { optionalEnvKeys: descriptor.optionalEnvKeys } : {}),
    ...(readme !== undefined ? { readme } : {}),
    ...(changelog !== undefined ? { changelog } : {}),
  };

  const result = await publishVersion(client, pkg.id, body);
  console.error('');
  console.error(
    `${colors.green('✓')} Published ${colors.bold(pkg.slug)}@${
      colors.cyan(result.packageVersion.version)
    } ${colors.dim(`(${(result.artifactBytes / 1024).toFixed(1)} KB)`)}`,
  );
  console.error(`  Version id: ${colors.dim(result.packageVersion.id)}`);
  console.error(`  Digest:     ${colors.dim(result.artifactDigest)}`);
  if (result.packageVersion.unlistedInstallToken) {
    console.error(
      `  Unlisted install token: ${colors.dim(result.packageVersion.unlistedInstallToken)}`,
    );
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}
