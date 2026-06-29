/**
 * `quickflo dashboards create` / `update <ref>` — manage dashboard metadata
 * (name, description, default flag, timezone). Widgets, layout, filters, and
 * data sources are managed through `pull`/`push` and the `sources` subgroup;
 * these two commands cover the lightweight metadata path.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { type Dashboard, resolveDashboardRef } from './dashboards-refs.ts';
import { openSession } from './session.ts';

export interface DashboardsCreateOptions {
  name: string;
  description?: string;
  timezone?: string;
  default?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runDashboardsCreate(
  opts: DashboardsCreateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards create');
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.description !== undefined) body['description'] = opts.description;
  if (opts.timezone !== undefined) body['timezone'] = opts.timezone;
  if (opts.default !== undefined) body['isDefault'] = opts.default;

  const created = await apiFetch<Dashboard>(client, '/dashboards', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (opts.json) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  console.error(
    `${colors.green('✓')} created dashboard ${colors.bold(created.name)} ${
      colors.dim(`(${created.id})`)
    }`,
  );
}

export interface DashboardsUpdateOptions {
  ref: string;
  name?: string;
  description?: string;
  timezone?: string;
  default?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runDashboardsUpdate(
  opts: DashboardsUpdateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards update');
  const resolved = await resolveDashboardRef(client, opts.ref);

  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body['name'] = opts.name;
  if (opts.description !== undefined) body['description'] = opts.description;
  if (opts.timezone !== undefined) body['timezone'] = opts.timezone;
  if (opts.default !== undefined) body['isDefault'] = opts.default;

  if (Object.keys(body).length === 0) {
    console.error(
      colors.dim('nothing to update (pass --name/--description/--timezone/--default).'),
    );
    return;
  }

  const updated = await apiFetch<Dashboard>(
    client,
    `/dashboards/${resolved.id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );

  if (opts.json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.error(
    `${colors.green('✓')} updated dashboard ${colors.bold(updated.name)} ${
      colors.dim(`(${updated.id})`)
    }`,
  );
}
