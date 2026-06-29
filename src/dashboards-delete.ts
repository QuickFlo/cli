/**
 * `quickflo dashboards delete <ref>` — delete a dashboard (and its widgets) by
 * UUID or name. Destructive: prompts unless --yes (auto-yes when stdin is not
 * a TTY, per the non-interactive contract).
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { resolveDashboardRef } from './dashboards-refs.ts';
import { openSession } from './session.ts';

export interface DashboardsDeleteOptions {
  ref: string;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
}

export async function runDashboardsDelete(
  opts: DashboardsDeleteOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'dashboards delete');
  const resolved = await resolveDashboardRef(client, opts.ref);

  if (
    !await confirmDestructive(
      `Delete dashboard "${resolved.name}" and ALL its widgets in ${org.name}?`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }

  await apiFetch<{ deleted: boolean }>(client, `/dashboards/${resolved.id}`, {
    method: 'DELETE',
  });
  console.error(
    `${colors.green('✓')} deleted dashboard ${colors.bold(resolved.name)} ${
      colors.dim(`(${resolved.id})`)
    }`,
  );
}
