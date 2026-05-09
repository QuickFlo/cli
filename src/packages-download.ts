/**
 * `quickflo packages download <ref>` — download a package version's
 * `.qfpkg.zip` artifact from the registry.
 *
 * `<ref>` auto-detects between two registry input shapes:
 *   1. Canonical address: `@orgSuid/localName` (latest version) or
 *      `@orgSuid/localName@<version>` (pinned). Resolves via
 *      `GET /packages/resolve/@:orgSuid/:localName`.
 *   2. Unlisted-install token: starts with `qfi_` → resolves via
 *      `GET /packages/install/u/:token`. Downloads the version the token
 *      was minted for.
 *
 * The artifact is streamed straight to disk — never JSON-decoded — via
 * `GET /packages/:id/versions/:version/artifact`.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve as resolvePath } from '@std/path';
import { type ApiClient } from './api.ts';
import { type EnvName } from './config.ts';
import { openSession } from './session.ts';
import {
  isUnlistedToken,
  type PackageRow,
  parseCanonicalRef,
  resolveCanonical,
  resolveUnlistedToken,
} from './packages-refs.ts';

type RefShape =
  | { kind: 'canonical'; orgSuid: string; localName: string; version?: string }
  | { kind: 'token'; token: string };

function detectRef(ref: string): RefShape {
  if (isUnlistedToken(ref)) {
    return { kind: 'token', token: ref };
  }
  const canonical = parseCanonicalRef(ref);
  if (canonical) {
    return canonical.version
      ? {
        kind: 'canonical',
        orgSuid: canonical.orgSuid,
        localName: canonical.localName,
        version: canonical.version,
      }
      : {
        kind: 'canonical',
        orgSuid: canonical.orgSuid,
        localName: canonical.localName,
      };
  }
  throw new Error(
    `Unrecognized ref "${ref}". Expected @orgSuid/name or @orgSuid/name@version (canonical), or qfi_… (unlisted token).`,
  );
}

async function streamArtifactToFile(
  client: ApiClient,
  packageId: string,
  version: string,
  outPath: string,
): Promise<{ bytes: number; path: string }> {
  const res = await fetch(
    `${client.apiUrl}/packages/${encodeURIComponent(packageId)}/versions/${
      encodeURIComponent(version)
    }/artifact`,
    {
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        'x-organization-id': client.orgId,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 404) {
      throw new Error(
        `Version "${version}" of package "${packageId}" not found or has no artifact.`,
      );
    }
    throw new Error(
      `Download failed (${res.status}): ${text || res.statusText}`,
    );
  }
  if (!res.body) {
    throw new Error('Download response had no body.');
  }

  const file = await Deno.open(outPath, {
    write: true,
    create: true,
    truncate: true,
  });
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      let written = 0;
      while (written < chunk.byteLength) {
        written += await file.write(chunk.subarray(written));
      }
    }
  } finally {
    file.close();
  }
  return { bytes, path: outPath };
}

function defaultFilename(slug: string, version: string): string {
  return `${slug}-${version}.qfpkg.zip`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export interface PackagesDownloadOptions {
  ref: string;
  env: EnvName;
  apiUrl?: string;
  orgId?: string;
  username?: string;
  password?: string;
  noCache?: boolean;
  out?: string;
  json?: boolean;
}

export async function runPackagesDownload(
  opts: PackagesDownloadOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'packages download');
  console.error(
    colors.dim(`\nTarget org: ${org.name} (${org.suid ?? org.id})`),
  );

  const ref = detectRef(opts.ref);

  let pkg: PackageRow;
  let version: string;
  if (ref.kind === 'canonical') {
    console.error(
      colors.dim(
        `Ref: canonical ${
          colors.bold(`@${ref.orgSuid}/${ref.localName}${ref.version ? `@${ref.version}` : ''}`)
        }`,
      ),
    );
    const resolved = await resolveCanonical(client, ref.orgSuid, ref.localName);
    pkg = resolved.pkg;
    if (ref.version) {
      version = ref.version;
    } else {
      if (!resolved.latestVersion) {
        throw new Error(
          `Package @${ref.orgSuid}/${ref.localName} has no published versions yet.`,
        );
      }
      version = resolved.latestVersion.version;
    }
  } else {
    console.error(
      colors.dim(
        `Ref: unlisted token ${colors.bold(ref.token.slice(0, 8) + '…')}`,
      ),
    );
    const resolved = await resolveUnlistedToken(client, ref.token);
    pkg = resolved.pkg;
    version = resolved.version.version;
  }

  const outPath = resolvePath(opts.out ?? defaultFilename(pkg.slug, version));

  console.error(
    `${colors.dim('Downloading')} ${colors.bold(`${pkg.slug}@${version}`)} ${colors.dim('→')} ${
      colors.bold(outPath)
    }`,
  );

  const result = await streamArtifactToFile(client, pkg.id, version, outPath);

  console.error(
    `${colors.green('✓')} Wrote ${colors.bold(formatBytes(result.bytes))} to ${
      colors.bold(result.path)
    }`,
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          packageId: pkg.id,
          slug: pkg.slug,
          name: pkg.name,
          version,
          path: result.path,
          bytes: result.bytes,
        },
        null,
        2,
      ),
    );
  }
}
