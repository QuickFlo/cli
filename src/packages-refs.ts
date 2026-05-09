/**
 * Shared package-ref parsing and registry resolution. Used by every
 * `packages` subcommand that has to turn a user-supplied ref string
 * (`@org/name`, `@org/name@1.2.0`, `qfi_…`) into a concrete
 * `(Package, PackageVersion)` pair.
 *
 * Single source of truth for the canonical-ref grammar — keep all command
 * files importing from here so the grammar can't drift between subcommands.
 */

import { type ApiClient } from './api.ts';

export interface PackageRow {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description?: string;
  visibility: 'public' | 'unlisted' | 'private';
}

export interface PackageVersionRow {
  id: string;
  packageId: string;
  version: string;
  manifest?: { slug?: string; version?: string };
  summary?: string;
  releaseNotes?: string;
}

export interface ResolveCanonicalResponse {
  package: PackageRow;
  latestVersion: PackageVersionRow | null;
}

export type CanonicalRef = {
  kind: 'canonical';
  orgSuid: string;
  localName: string;
  /** Optional pinned version. When absent, callers should resolve to latest. */
  version?: string;
};

export type TokenRef = { kind: 'token'; token: string };

// Canonical with optional `@<version>` suffix. The version segment accepts
// any non-`@`/non-`/` chars so semver pre-release / build metadata work
// without baking in a strict semver regex (the API is the source of truth
// on what's a valid version string).
const CANONICAL_RE = /^@([a-z0-9]+)\/([a-z0-9][a-z0-9-]*)(?:@([^@/]+))?$/i;

export const TOKEN_PREFIX = 'qfi_';

export function parseCanonicalRef(ref: string): CanonicalRef | null {
  const m = CANONICAL_RE.exec(ref);
  if (!m) return null;
  const [, orgSuid, localName, version] = m;
  return version
    ? { kind: 'canonical', orgSuid, localName, version }
    : { kind: 'canonical', orgSuid, localName };
}

export function isUnlistedToken(ref: string): boolean {
  return ref.startsWith(TOKEN_PREFIX);
}

export async function resolveCanonical(
  client: ApiClient,
  orgSuid: string,
  localName: string,
): Promise<{ pkg: PackageRow; latestVersion: PackageVersionRow | null }> {
  const path = `/packages/resolve/@${encodeURIComponent(orgSuid)}/${encodeURIComponent(localName)}`;
  const res = await fetch(`${client.apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      'x-organization-id': client.orgId,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Could not resolve @${orgSuid}/${localName}: ${res.status} ${text || res.statusText}`,
    );
  }
  const body = (await res.json()) as ResolveCanonicalResponse;
  return { pkg: body.package, latestVersion: body.latestVersion };
}

export async function resolveUnlistedToken(
  client: ApiClient,
  token: string,
): Promise<{ pkg: PackageRow; version: PackageVersionRow }> {
  const versionRes = await fetch(
    `${client.apiUrl}/packages/install/u/${encodeURIComponent(token)}`,
    {
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        'x-organization-id': client.orgId,
      },
    },
  );
  if (!versionRes.ok) {
    if (versionRes.status === 404) {
      throw new Error('Install link is invalid or has expired.');
    }
    const text = await versionRes.text().catch(() => '');
    throw new Error(
      `Token resolve failed (${versionRes.status}): ${text || versionRes.statusText}`,
    );
  }
  const version = (await versionRes.json()) as PackageVersionRow;
  // The token endpoint returns the version only — fetch the parent Package
  // so callers can render the package name + slug. The package is visible
  // via the token's capability, so the standard visibility-aware GET works.
  const pkgRes = await fetch(
    `${client.apiUrl}/packages/${encodeURIComponent(version.packageId)}`,
    {
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        'x-organization-id': client.orgId,
      },
    },
  );
  if (!pkgRes.ok) {
    const text = await pkgRes.text().catch(() => '');
    throw new Error(
      `Token resolved but package fetch failed (${pkgRes.status}): ${text || pkgRes.statusText}`,
    );
  }
  const pkg = (await pkgRes.json()) as PackageRow;
  return { pkg, version };
}
