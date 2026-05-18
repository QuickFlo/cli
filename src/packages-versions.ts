/**
 * `quickflo packages list-versions <@org/name>` — list every published
 * version of a package, newest first.
 *
 * Resolves the canonical address to a package id, then paginates
 * `GET /packages/:id/versions`.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { parseCanonicalRef, resolveCanonical } from './packages-refs.ts';
import { openSession } from './session.ts';

interface VersionRow {
  id: string;
  packageId: string;
  version: string;
  summary?: string;
  releaseNotes?: string;
  artifactDigest?: string;
  publishedAt?: string;
  createdAt?: string;
}

interface VersionListResponse {
  data: VersionRow[];
  total: number;
}

async function fetchVersions(
  client: ApiClient,
  packageId: string,
  opts: ListOptions & { all: boolean },
): Promise<VersionRow[]> {
  if (!opts.all) {
    const params = buildListParams(opts);
    if (!params.has('options[limit]')) params.set('options[limit]', '50');
    const res = await apiFetch<VersionListResponse>(
      client,
      `/packages/${encodeURIComponent(packageId)}/versions?${params.toString()}`,
    );
    return res.data ?? [];
  }
  const pageSize = 100;
  let offset = 0;
  const all: VersionRow[] = [];
  while (true) {
    const params = buildListParams(opts);
    params.set('options[limit]', String(pageSize));
    params.set('options[offset]', String(offset));
    const res = await apiFetch<VersionListResponse>(
      client,
      `/packages/${encodeURIComponent(packageId)}/versions?${params.toString()}`,
    );
    const page = res.data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : '-';
}

function printTable(rows: VersionRow[]): void {
  if (rows.length === 0) {
    console.log(colors.dim('(no versions)'));
    return;
  }
  const verWidth = Math.max(7, ...rows.map((r) => r.version.length));
  const sumWidth = Math.min(
    50,
    Math.max(3, ...rows.map((r) => (r.summary ?? '').length)),
  );
  const header = [
    'VERSION'.padEnd(verWidth),
    'PUBLISHED',
    'DIGEST',
    'SUMMARY'.padEnd(sumWidth),
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const r of rows) {
    const digest = r.artifactDigest ? r.artifactDigest.slice(0, 10) : '-';
    console.log([
      r.version.padEnd(verWidth),
      formatDate(r.publishedAt ?? r.createdAt),
      digest,
      truncate(r.summary ?? '-', sumWidth).padEnd(sumWidth),
    ].join('  '));
  }
}

export interface PackagesListVersionsOptions extends ListOptions {
  ref: string;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  all?: boolean;
}

export async function runPackagesListVersions(
  opts: PackagesListVersionsOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'packages list-versions');
  const canonical = parseCanonicalRef(opts.ref);
  if (!canonical) {
    throw new Error(
      `Unrecognized package ref "${opts.ref}". Expected canonical @orgSuid/name.`,
    );
  }
  const { pkg } = await resolveCanonical(client, canonical.orgSuid, canonical.localName);
  const rows = await fetchVersions(client, pkg.id, {
    name: opts.name,
    where: opts.where,
    rawQuery: opts.rawQuery,
    limit: opts.limit,
    order: opts.order ?? 'createdAt:DESC',
    all: opts.all ?? false,
  });
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.error(
    colors.dim(
      `\n${pkg.name} (@${canonical.orgSuid}/${canonical.localName}) — ${rows.length} version(s)\n`,
    ),
  );
  printTable(rows);
}
