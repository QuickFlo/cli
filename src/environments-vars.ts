/**
 * Per-variable verbs for environments:
 *   - `set <env> <key> <value>`  → PATCH /:id/variables/:key
 *   - `unset <env> <key>`        → DELETE /:id/variables/:key
 *   - `vars <env>` (`--mask`)    → keys-only or full key/value listing
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { fetchVariableKeys, fetchVariables, resolveEnvironmentRef } from './environments-get.ts';
import { type Lookup } from './refs.ts';
import { openSession } from './session.ts';

export interface EnvironmentsVarsOptions {
  ref: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
  mask?: boolean;
}

export async function runEnvironmentsVars(
  opts: EnvironmentsVarsOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'environments vars');
  const env = await resolveEnvironmentRef(client, opts.ref, opts.by);

  if (opts.mask) {
    const keys = await fetchVariableKeys(client, env.id);
    if (opts.json) {
      console.log(JSON.stringify(keys, null, 2));
      return;
    }
    console.error(colors.dim(`\n${env.name} — ${keys.length} variable(s) (keys only)\n`));
    for (const k of keys) console.log(k);
    return;
  }

  const vars = await fetchVariables(client, env.id);
  if (opts.json) {
    console.log(JSON.stringify(vars, null, 2));
    return;
  }
  console.error(
    colors.dim(`\n${env.name} — ${Object.keys(vars).length} variable(s)\n`),
  );
  const keyWidth = Math.max(
    3,
    ...Object.keys(vars).map((k) => k.length),
  );
  for (const [k, v] of Object.entries(vars)) {
    console.log(`${k.padEnd(keyWidth)}  ${v}`);
  }
}

export interface EnvironmentsVarSetOptions {
  ref: string;
  key: string;
  value: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runEnvironmentsVarSet(
  opts: EnvironmentsVarSetOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'environments set');
  const env = await resolveEnvironmentRef(client, opts.ref, opts.by);
  if (opts.value === '***') {
    console.error(
      colors.red(
        `Refusing to set "${opts.key}" to the mask placeholder "***" — pass a real value or use \`environments unset\`.`,
      ),
    );
    Deno.exit(1);
  }
  await apiFetch(client, `/environments/${env.id}/variables/${encodeURIComponent(opts.key)}`, {
    method: 'PATCH',
    body: JSON.stringify({ value: opts.value }),
  });
  console.error(
    `${colors.green('✓')} set ${colors.bold(opts.key)} on ${env.name}`,
  );
}

export interface EnvironmentsVarUnsetOptions {
  ref: string;
  key: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
}

export async function runEnvironmentsVarUnset(
  opts: EnvironmentsVarUnsetOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'environments unset');
  const env = await resolveEnvironmentRef(client, opts.ref, opts.by);
  await apiFetch(client, `/environments/${env.id}/variables/${encodeURIComponent(opts.key)}`, {
    method: 'DELETE',
  });
  console.error(
    `${colors.green('✓')} unset ${colors.bold(opts.key)} on ${env.name}`,
  );
}
