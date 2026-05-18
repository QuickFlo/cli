/**
 * `quickflo environments create --name <name> [--var KEY=VALUE ...]`
 *
 * Creates an empty environment, or one seeded with the variables passed
 * inline. Variable edits after creation go through `environments set` /
 * `unset` / `push --prune`.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';

function parseVarFlag(expr: string): [string, string] {
  const eq = expr.indexOf('=');
  if (eq <= 0) {
    throw new Error(`--var "${expr}" must be KEY=VALUE`);
  }
  const key = expr.slice(0, eq);
  const value = expr.slice(eq + 1);
  if (!key) throw new Error(`--var "${expr}": empty key`);
  if (value === '***') {
    throw new Error(
      `--var "${key}=***" refused: "***" is the mask placeholder, not a real value.`,
    );
  }
  return [key, value];
}

export interface EnvironmentsCreateOptions {
  name: string;
  vars?: string[];
  apiUrl?: string;
  orgId?: string;
}

export async function runEnvironmentsCreate(
  opts: EnvironmentsCreateOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'environments create');
  const variables = (opts.vars ?? []).map(parseVarFlag).map(([key, value]) => ({
    key,
    value,
  }));
  const created = await apiFetch<{ id: string; name: string }>(
    client,
    `/environments`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        organizationId: client.orgId,
        variables,
      }),
    },
  );
  console.error(
    `${colors.green('✓')} created environment ${colors.bold(created.name)} ${
      colors.dim(created.id)
    } (${variables.length} vars)`,
  );
  console.log(JSON.stringify(created, null, 2));
}
