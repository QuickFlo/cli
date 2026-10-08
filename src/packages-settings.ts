import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { openSession } from './session.ts';
import type {
  PackageSettingsOptionsResponse,
  PackageSettingsRecordsResponse,
  PackageSettingsResponse,
  PackageSettingsSource,
} from './packages-settings.types.ts';

interface CommonOptions {
  orgId?: string;
  json?: boolean;
}

type InstalledOptions = CommonOptions & { installId: string };
type SourceOptions = InstalledOptions & { sourceId: string };
export type PackagesSettingsOptions =
  | (InstalledOptions & { action: 'describe' })
  | (CommonOptions & { action: 'published'; packageId: string; version: string })
  | (SourceOptions & {
    action: 'records';
    key?: string;
    afterKey?: string;
    all?: boolean;
  })
  | (SourceOptions & {
    action: 'options';
    path: string;
    search?: string;
    cursor?: number;
    selected?: string;
  })
  | (SourceOptions & { action: 'save' | 'delete'; file: string; dryRun?: boolean; yes?: boolean });

export interface PackagesSettingsDependencies {
  openSession: typeof openSession;
  apiFetch: typeof apiFetch;
  readTextFile(path: string): Promise<string>;
  confirmDestructive: typeof confirmDestructive;
}

const dependencies: PackagesSettingsDependencies = {
  openSession,
  apiFetch,
  readTextFile: (path) => Deno.readTextFile(path),
  confirmDestructive,
};

function print(value: unknown, json?: boolean) {
  console.log(JSON.stringify(value, null, json ? undefined : 2));
}

/** Check the request envelope before any mutation; leave contract validation to the server. */
function readMutation(text: string, action: 'save' | 'delete'): Record<string, unknown> {
  const input: unknown = JSON.parse(text);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('--file must contain a settings request object.');
  }
  const body = input as Record<string, unknown>;
  if (
    typeof body['key'] !== 'string' || !body['key'].trim() ||
    typeof body['packageVersionId'] !== 'string' || !body['packageVersionId']
  ) {
    throw new Error('Settings requests require key and packageVersionId from settings describe.');
  }
  if (
    !(typeof body['revision'] === 'string' && body['revision'].length > 0) &&
    !(action === 'save' && body['revision'] === null)
  ) {
    throw new Error(
      'Include the revision from settings records; use null only when creating a record.',
    );
  }
  const allowed = [
    'key',
    'packageVersionId',
    'revision',
    ...(action === 'save' ? ['changes'] : []),
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error(`Settings ${action} accepts only: ${allowed.join(', ')}.`);
  }
  if (action === 'save' && (!Array.isArray(body['changes']) || !body['changes'].length)) {
    throw new Error('Settings save requires a non-empty changes array of set/remove operations.');
  }
  return body;
}

export async function runPackagesSettings(
  opts: PackagesSettingsOptions,
  deps: PackagesSettingsDependencies = dependencies,
): Promise<void> {
  // A malformed file must not cause a request or an interactive confirmation.
  const body = opts.action === 'save' || opts.action === 'delete'
    ? readMutation(await deps.readTextFile(opts.file), opts.action)
    : undefined;
  const { client, org } = await deps.openSession(opts, `packages settings ${opts.action}`);
  if (opts.action === 'published') {
    const result = await deps.apiFetch<{ sources: Record<string, PackageSettingsSource> }>(
      client,
      `/packages/${encodeURIComponent(opts.packageId)}/versions/${
        encodeURIComponent(opts.version)
      }/settings`,
    );
    print(result, opts.json);
    return;
  }
  const base = `/package-installs/${encodeURIComponent(opts.installId)}/settings`;
  if (opts.action === 'describe') {
    print(await deps.apiFetch<PackageSettingsResponse>(client, base), opts.json);
    return;
  }
  const source = `${base}/${encodeURIComponent(opts.sourceId)}`;
  if (opts.action === 'options') {
    const query = new URLSearchParams({ path: opts.path });
    if (opts.search !== undefined) {
      query.set('search', opts.search);
    }
    if (opts.cursor !== undefined) {
      query.set('cursor', String(opts.cursor));
    }
    if (opts.selected !== undefined) {
      query.set('selected', opts.selected);
    }
    print(
      await deps.apiFetch<PackageSettingsOptionsResponse>(client, `${source}/options?${query}`),
      opts.json,
    );
    return;
  }
  if (opts.action === 'records') {
    if (opts.key !== undefined && opts.afterKey !== undefined) {
      throw new Error('--key and --after-key cannot be combined.');
    }
    const query = new URLSearchParams();
    if (opts.key !== undefined) {
      query.set('key', opts.key);
    }
    if (opts.afterKey !== undefined) {
      query.set('afterKey', opts.afterKey);
    }
    const result: PackageSettingsRecordsResponse = { records: [], hasMore: false };
    const cursors = new Set<string>();
    if (opts.afterKey !== undefined) {
      cursors.add(opts.afterKey);
    }
    do {
      const page = await deps.apiFetch<PackageSettingsRecordsResponse>(
        client,
        `${source}/records?${query}`,
      );
      result.records.push(...page.records);
      result.hasMore = page.hasMore;
      if (!opts.all || !page.hasMore || opts.key !== undefined) {
        break;
      }
      const cursor = page.records.at(-1)?.key;
      if (!cursor || cursors.has(cursor)) {
        throw new Error('Settings pagination did not advance; retry the read.');
      }
      cursors.add(cursor);
      query.set('afterKey', cursor);
    } while (result.hasMore);
    print(result, opts.json);
    return;
  }
  const path = `${source}/records${opts.action === 'delete' ? '/delete' : ''}`;
  if (opts.dryRun) {
    print({ dryRun: true, method: 'POST', path, body }, opts.json);
    return;
  }
  if (
    opts.action === 'delete' && !await deps.confirmDestructive(
      `Delete settings record ${String(body?.['key'])} from ${opts.sourceId} in ${org.name}?`,
      opts.yes,
    )
  ) {
    console.error('aborted.');
    return;
  }
  // Never refresh revisions or retry writes: a conflict requires the caller to reread and review.
  print(
    await deps.apiFetch<PackageSettingsRecordsResponse | { deleted: boolean }>(client, path, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    opts.json,
  );
}
