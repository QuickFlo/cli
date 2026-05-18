/**
 * `quickflo packages uninstall <install-id>` — DELETE /package-installs/:id.
 * Confirms before deleting unless `--yes` is passed. Prints the server's
 * `deleted` summary (workflows / triggers / dashboards / dashboard data
 * sources removed).
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { confirmDestructive } from './confirm.ts';
import { openSession } from './session.ts';

interface UninstallResult {
  deleted: {
    workflows?: number;
    triggers?: number;
    dashboards?: number;
    dashboardDataSources?: number;
    [key: string]: number | undefined;
  };
}

export interface PackagesUninstallOptions {
  installId: string;
  apiUrl?: string;
  orgId?: string;
  yes?: boolean;
  json?: boolean;
}

export async function runPackagesUninstall(
  opts: PackagesUninstallOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'packages uninstall');
  if (
    !await confirmDestructive(
      `Uninstall package install ${opts.installId} in ${org.name}? This deletes every resource the install created.`,
      opts.yes,
    )
  ) {
    console.error(colors.dim('aborted.'));
    return;
  }
  const res = await apiFetch<UninstallResult>(
    client,
    `/package-installs/${encodeURIComponent(opts.installId)}`,
    { method: 'DELETE' },
  );
  console.error(`${colors.green('✓')} uninstalled ${colors.dim(opts.installId)}`);
  console.error('  Deleted:');
  for (const [k, v] of Object.entries(res.deleted ?? {})) {
    console.error(`    ${k}: ${v ?? 0}`);
  }
  if (opts.json) console.log(JSON.stringify(res, null, 2));
}
