/**
 * Hydrate `packageInstallId` values on org-scoped rows (workflows, etc.)
 * into a human-readable `slug@version` address.
 *
 * Used by `workflows list --include-packages` and `workflows pull
 * --include-packages` to annotate package-installed rows with where they
 * came from. Cheaper than per-row fetches: one `$in` query returns all
 * the installs plus sidecar packages + versions in a single round-trip.
 */

import { type ApiClient, apiFetch } from './api.ts';

interface PackageInstallRow {
  id: string;
  packageId: string;
  packageVersionId: string;
}

interface PackageRow {
  id: string;
  slug: string;
}

interface PackageVersionRow {
  id: string;
  version: string;
}

interface PackageInstallsListResponse {
  data: PackageInstallRow[];
  packages?: PackageRow[];
  versions?: PackageVersionRow[];
}

/**
 * Resolve a set of packageInstall IDs to `slug@version` strings.
 *
 * Returns an empty map when given no IDs (no network call). Any ID that
 * doesn't resolve (deleted install, missing sidecar) is simply absent
 * from the result — callers decide how to render the unknown case.
 */
export async function resolveInstallAddresses(
  client: ApiClient,
  installIds: Iterable<string>,
): Promise<Map<string, string>> {
  const ids = [...new Set(installIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  const params = new URLSearchParams();
  for (const id of ids) params.append('where[id][$in]', id);
  params.set('options[limit]', String(ids.length));

  const res = await apiFetch<PackageInstallsListResponse>(
    client,
    `/package-installs?${params.toString()}`,
  );
  const pkgById = new Map((res.packages ?? []).map((p) => [p.id, p]));
  const verById = new Map((res.versions ?? []).map((v) => [v.id, v]));
  for (const inst of res.data ?? []) {
    const slug = pkgById.get(inst.packageId)?.slug;
    const version = verById.get(inst.packageVersionId)?.version;
    if (slug && version) out.set(inst.id, `${slug}@${version}`);
    else if (slug) out.set(inst.id, slug);
  }
  return out;
}
