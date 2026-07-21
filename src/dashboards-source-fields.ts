/**
 * Computed fields on dashboard data sources: calculated fields (jsep formulas,
 * including `$ds.<table>.<key>` data-store refs) and window dimensions
 * (`row_number` rank fields; ClickHouse-served sources only). Both live in the
 * source's `recordSchema` and are referenced BY NAME in widget queries via the
 * `ds_<uuid>` alias.
 *
 * The generic source update endpoint (`PATCH /dashboards/data-sources/:id`)
 * silently strips both families from `recordSchema` — the server only accepts
 * them through dedicated routes:
 *
 *   POST   /dashboards/data-sources/:id/calculated-fields
 *   PATCH  /dashboards/data-sources/:id/calculated-fields/:fieldId
 *   DELETE /dashboards/data-sources/:id/calculated-fields/:fieldId
 *   POST   /dashboards/data-sources/:id/window-dimensions
 *   PATCH  /dashboards/data-sources/:id/window-dimensions/:fieldId
 *   DELETE /dashboards/data-sources/:id/window-dimensions/:fieldId
 *
 * This module wraps those routes as `dashboards sources` subcommands and
 * provides the name-based reconcile that `dashboards import` runs so a
 * cross-org import carries computed-field parity (create missing, update
 * drifted, never delete).
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import {
  type CalculatedField,
  resolveDataSourceRef,
  type WindowDimension,
} from './dashboards-refs.ts';
import { UserError } from './errors.ts';
import { info } from './log.ts';
import { openSession } from './session.ts';

// ── projections + sync planning (pure; unit-tested) ─────────────────────

/** The writable body for a calculated field, minus server-managed keys. */
export function projectCalcField(cf: CalculatedField): Record<string, unknown> {
  return dropUndefined({
    name: cf.name,
    label: cf.label,
    type: cf.type,
    expression: cf.expression,
    formula: cf.formula,
    measure: cf.measure,
  });
}

/** The writable body for a window dimension, minus server-managed keys. */
export function projectWindowDim(wd: WindowDimension): Record<string, unknown> {
  return dropUndefined({
    name: wd.name,
    label: wd.label,
    function: wd.function,
    partitionBy: wd.partitionBy,
    orderBy: wd.orderBy,
    direction: wd.direction,
    semantic: wd.semantic,
  });
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}

/** Stable deep-equality over writable projections (key order independent). */
function sameDefinition(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export type ComputedFieldFamily = 'calculated-field' | 'window-dimension';

export interface ComputedFieldAction {
  family: ComputedFieldFamily;
  action: 'create' | 'update' | 'skip';
  name: string;
  /** Target field id when updating an existing field. */
  targetFieldId?: string;
  body: Record<string, unknown>;
}

/**
 * Diff a desired set of computed fields against a target source's schema.
 * Matching is by `name` (widgets bind by name). Additive only: fields that
 * exist only on the target are left alone — an import must never delete
 * fields other dashboards may reference.
 */
export function planComputedFieldSync(
  desired: {
    calculatedFields?: CalculatedField[];
    windowDimensions?: WindowDimension[];
  },
  target: {
    calculatedFields?: CalculatedField[];
    windowDimensions?: WindowDimension[];
  },
): ComputedFieldAction[] {
  const actions: ComputedFieldAction[] = [];

  const targetCalc = new Map(
    (target.calculatedFields ?? []).map((cf) => [cf.name, cf]),
  );
  for (const cf of desired.calculatedFields ?? []) {
    const body = projectCalcField(cf);
    const existing = targetCalc.get(cf.name);
    if (!existing) {
      actions.push({ family: 'calculated-field', action: 'create', name: cf.name, body });
    } else if (sameDefinition(body, projectCalcField(existing))) {
      actions.push({ family: 'calculated-field', action: 'skip', name: cf.name, body });
    } else {
      actions.push({
        family: 'calculated-field',
        action: 'update',
        name: cf.name,
        targetFieldId: existing.id,
        body,
      });
    }
  }

  const targetWin = new Map(
    (target.windowDimensions ?? []).map((wd) => [wd.name, wd]),
  );
  for (const wd of desired.windowDimensions ?? []) {
    const body = projectWindowDim(wd);
    const existing = targetWin.get(wd.name);
    if (!existing) {
      actions.push({ family: 'window-dimension', action: 'create', name: wd.name, body });
    } else if (sameDefinition(body, projectWindowDim(existing))) {
      actions.push({ family: 'window-dimension', action: 'skip', name: wd.name, body });
    } else {
      actions.push({
        family: 'window-dimension',
        action: 'update',
        name: wd.name,
        targetFieldId: existing.id,
        body,
      });
    }
  }

  return actions;
}

// ── execution ───────────────────────────────────────────────────────────

function familyPath(family: ComputedFieldFamily): string {
  return family === 'calculated-field' ? 'calculated-fields' : 'window-dimensions';
}

export interface ComputedFieldSyncResult {
  action: ComputedFieldAction;
  ok: boolean;
  error?: string;
}

/**
 * Apply a sync plan against one data source. Failures are collected per
 * field, not thrown — a window dimension can legitimately be rejected (e.g.
 * the target source is Postgres-served) without invalidating the rest.
 */
export async function applyComputedFieldSync(
  client: ApiClient,
  sourceId: string,
  actions: ComputedFieldAction[],
): Promise<ComputedFieldSyncResult[]> {
  const results: ComputedFieldSyncResult[] = [];
  for (const action of actions) {
    if (action.action === 'skip') {
      results.push({ action, ok: true });
      continue;
    }
    const base = `/dashboards/data-sources/${sourceId}/${familyPath(action.family)}`;
    try {
      if (action.action === 'create') {
        await apiFetch(client, base, {
          method: 'POST',
          body: JSON.stringify(action.body),
        });
      } else {
        if (!action.targetFieldId) {
          throw new Error(`no target field id for ${action.name}`);
        }
        await apiFetch(client, `${base}/${action.targetFieldId}`, {
          method: 'PATCH',
          body: JSON.stringify(action.body),
        });
      }
      results.push({ action, ok: true });
    } catch (err) {
      results.push({ action, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

// ── command runners ─────────────────────────────────────────────────────

interface CommonOptions {
  apiUrl?: string;
  orgId?: string;
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    throw new UserError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new UserError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

export interface SourceFieldsListOptions extends CommonOptions {
  ref: string;
  json?: boolean;
}

/** `dashboards sources fields <ref>` — list both computed-field families. */
export async function runSourceFieldsList(
  opts: SourceFieldsListOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards sources fields');
  const ds = await resolveDataSourceRef(client, opts.ref);
  const calc = ds.recordSchema?.calculatedFields ?? [];
  const win = ds.recordSchema?.windowDimensions ?? [];

  if (opts.json) {
    console.log(JSON.stringify({ calculatedFields: calc, windowDimensions: win }, null, 2));
    return;
  }

  info(
    colors.dim(
      `\n${ds.name} — ${calc.length} calculated field(s), ${win.length} window dimension(s)\n`,
    ),
  );
  for (const cf of calc) {
    console.log(
      `${colors.bold(cf.name)}  ${colors.dim(`[calc ${cf.type}${cf.measure ? ', measure' : ''}]`)}`,
    );
    if (cf.formula) console.log(`  ${colors.dim(cf.formula)}`);
    if (cf.id) console.log(`  ${colors.dim(`id: ${cf.id}`)}`);
  }
  for (const wd of win) {
    console.log(
      `${colors.bold(wd.name)}  ${
        colors.dim(
          `[window ${wd.function} over ${wd.partitionBy.join(', ')} by ${wd.orderBy} ${
            wd.direction ?? 'asc'
          }]`,
        )
      }`,
    );
    if (wd.id) console.log(`  ${colors.dim(`id: ${wd.id}`)}`);
  }
}

export interface SourceFieldSetOptions extends CommonOptions {
  ref: string;
  file: string;
  json?: boolean;
}

async function runFieldSet(
  family: ComputedFieldFamily,
  commandName: string,
  opts: SourceFieldSetOptions,
): Promise<void> {
  const { client } = await openSession(opts, commandName);
  const ds = await resolveDataSourceRef(client, opts.ref);
  const body = await readJsonFile(opts.file);
  if (typeof body['name'] !== 'string' || body['name'].length === 0) {
    throw new UserError(`${opts.file} must contain a "name" — fields are upserted by name.`);
  }

  const desired = family === 'calculated-field'
    ? { calculatedFields: [body as unknown as CalculatedField] }
    : { windowDimensions: [body as unknown as WindowDimension] };
  const actions = planComputedFieldSync(desired, ds.recordSchema ?? {});
  const [result] = await applyComputedFieldSync(client, ds.id, actions);

  if (!result.ok) {
    throw new UserError(
      `Failed to ${result.action.action} ${family} "${body['name']}": ${result.error}`,
    );
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const verb = { create: 'created', update: 'updated', skip: 'unchanged' }[result.action.action];
  info(
    `${colors.green('✓')} ${verb} ${family} ${colors.bold(String(body['name']))} on ${
      colors.bold(ds.name)
    }`,
  );
}

export function runCalcFieldSet(opts: SourceFieldSetOptions): Promise<void> {
  return runFieldSet('calculated-field', 'dashboards sources calc-field set', opts);
}

export function runWindowDimSet(opts: SourceFieldSetOptions): Promise<void> {
  return runFieldSet('window-dimension', 'dashboards sources window-dim set', opts);
}

export interface SourceFieldDeleteOptions extends CommonOptions {
  ref: string;
  name: string;
  json?: boolean;
}

async function runFieldDelete(
  family: ComputedFieldFamily,
  commandName: string,
  opts: SourceFieldDeleteOptions,
): Promise<void> {
  const { client } = await openSession(opts, commandName);
  const ds = await resolveDataSourceRef(client, opts.ref);
  const pool: Array<{ id?: string; name: string }> = family === 'calculated-field'
    ? ds.recordSchema?.calculatedFields ?? []
    : ds.recordSchema?.windowDimensions ?? [];
  const match = pool.find((f) => f.name === opts.name);
  if (!match) {
    throw new UserError(
      `No ${family} named "${opts.name}" on ${ds.name}. Existing: ${
        pool.map((f) => f.name).join(', ') || '(none)'
      }`,
    );
  }
  if (!match.id) {
    throw new UserError(`${family} "${opts.name}" has no id on the server record.`);
  }
  await apiFetch(
    client,
    `/dashboards/data-sources/${ds.id}/${familyPath(family)}/${match.id}`,
    { method: 'DELETE' },
  );
  if (opts.json) {
    console.log(JSON.stringify({ deleted: opts.name, id: match.id }, null, 2));
    return;
  }
  info(
    `${colors.green('✓')} deleted ${family} ${colors.bold(opts.name)} from ${colors.bold(ds.name)}`,
  );
}

export function runCalcFieldDelete(opts: SourceFieldDeleteOptions): Promise<void> {
  return runFieldDelete('calculated-field', 'dashboards sources calc-field delete', opts);
}

export function runWindowDimDelete(opts: SourceFieldDeleteOptions): Promise<void> {
  return runFieldDelete('window-dimension', 'dashboards sources window-dim delete', opts);
}

// ── import-side reporting helper ────────────────────────────────────────

/** Tally one source's sync results for the import path's report. */
export function describeSyncResults(
  results: ComputedFieldSyncResult[],
): { created: number; updated: number; skipped: number; failures: ComputedFieldSyncResult[] } {
  const created = results.filter((r) => r.ok && r.action.action === 'create').length;
  const updated = results.filter((r) => r.ok && r.action.action === 'update').length;
  const skipped = results.filter((r) => r.ok && r.action.action === 'skip').length;
  const failures = results.filter((r) => !r.ok);
  return { created, updated, skipped, failures };
}
