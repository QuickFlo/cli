/**
 * `quickflo workflows validate <file>|--from-stdin` — sanity-check a workflow
 * definition before pushing. Runs locally with zero network calls by default;
 * `--strict` adds a server round-trip to validate per-step `config` against
 * the live `inputSchema` for each step type.
 *
 * Local checks (best-effort; mirrors the platform's own three semantic rules):
 *   - shape: top-level `name` (string) + `steps` (array)
 *   - per-step: `stepType` present; if `id` present, must be unique
 *   - CodeStepInConcurrentForEach: codeStep inside a forEach with concurrency > 1
 *   - UnknownFilterRule: any filter referencing a stepId that doesn't exist
 *   - CodeStepRequiresMediumTier: emits a warning (server enforces tier)
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { UserError, ValidationError } from './errors.ts';

interface StepLike {
  id?: string;
  stepType?: string;
  config?: Record<string, unknown> & {
    concurrency?: number;
    steps?: StepLike[];
    filters?: unknown;
  };
  steps?: StepLike[];
}

interface DefinitionLike {
  name?: string;
  steps?: StepLike[];
}

interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

interface StepInfo {
  stepType: string;
  inputSchema?: Record<string, unknown>;
}

function readSource(source: string | undefined, fromStdin: boolean): string {
  if (fromStdin) return new TextDecoder().decode(readAllSync(Deno.stdin));
  if (!source) {
    throw new UserError('Pass a file path or --from-stdin.');
  }
  return Deno.readTextFileSync(source);
}

function readAllSync(reader: { readSync(p: Uint8Array): number | null }): Uint8Array {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  while (true) {
    const n = reader.readSync(buf);
    if (n === null || n === 0) break;
    chunks.push(buf.slice(0, n));
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function walkSteps(
  steps: StepLike[] | undefined,
  prefix: string,
  fn: (s: StepLike, path: string) => void,
): void {
  if (!Array.isArray(steps)) return;
  steps.forEach((s, i) => {
    const path = `${prefix}[${i}]`;
    fn(s, path);
    // forEach / branch / sequence sub-steps live under config.steps or s.steps
    walkSteps(s.config?.steps, `${path}.config.steps`, fn);
    walkSteps(s.steps, `${path}.steps`, fn);
  });
}

function localValidate(def: DefinitionLike): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (typeof def !== 'object' || def === null) {
    errors.push({ path: '$', message: 'definition must be a JSON object', code: 'shape' });
    return { ok: false, errors, warnings };
  }
  if (typeof def.name !== 'string' || def.name.length === 0) {
    errors.push({ path: '$.name', message: 'missing or empty `name`', code: 'shape' });
  }
  if (!Array.isArray(def.steps)) {
    errors.push({ path: '$.steps', message: '`steps` must be an array', code: 'shape' });
    return { ok: errors.length === 0, errors, warnings };
  }

  const ids = new Set<string>();
  const allStepIds = new Set<string>();
  walkSteps(def.steps, '$.steps', (s, path) => {
    if (typeof s !== 'object' || s === null) {
      errors.push({ path, message: 'step must be an object', code: 'shape' });
      return;
    }
    if (typeof s.stepType !== 'string' || s.stepType.length === 0) {
      errors.push({ path: `${path}.stepType`, message: 'missing `stepType`', code: 'shape' });
    }
    if (typeof s.id === 'string') {
      if (ids.has(s.id)) {
        errors.push({
          path: `${path}.id`,
          message: `duplicate step id "${s.id}"`,
          code: 'duplicate_id',
        });
      }
      ids.add(s.id);
      allStepIds.add(s.id);
    }
    if (s.stepType === 'codeStep') {
      warnings.push({
        path,
        message: 'codeStep requires medium-tier plan (enforced server-side)',
        code: 'CodeStepRequiresMediumTier',
      });
    }
  });

  walkSteps(def.steps, '$.steps', (s, path) => {
    if (s.stepType === 'forEach') {
      const concurrency = typeof s.config?.concurrency === 'number' ? s.config.concurrency : 1;
      if (concurrency > 1) {
        walkSteps(s.config?.steps, `${path}.config.steps`, (child, childPath) => {
          if (child.stepType === 'codeStep') {
            errors.push({
              path: childPath,
              message: 'codeStep cannot live inside a forEach with concurrency > 1',
              code: 'CodeStepInConcurrentForEach',
            });
          }
        });
      }
    }
  });

  walkSteps(def.steps, '$.steps', (s, path) => {
    const filters = s.config?.filters;
    if (!Array.isArray(filters)) return;
    filters.forEach((f, i) => {
      if (typeof f !== 'object' || f === null) return;
      const fr = f as Record<string, unknown>;
      if (typeof fr.stepId === 'string' && fr.stepId.length > 0 && !allStepIds.has(fr.stepId)) {
        errors.push({
          path: `${path}.config.filters[${i}].stepId`,
          message: `unknown stepId "${fr.stepId}"`,
          code: 'UnknownFilterRule',
        });
      }
    });
  });

  return { ok: errors.length === 0, errors, warnings };
}

async function strictValidate(
  orgId: string | undefined,
  def: DefinitionLike,
): Promise<ValidationIssue[]> {
  if (!orgId) {
    throw new UserError('--strict requires --org / QF_ORG (server-side schema fetch needs auth).');
  }
  const { client } = await openSession({ orgId }, 'workflows validate --strict');
  const types = new Set<string>();
  walkSteps(def.steps, '$.steps', (s) => {
    if (typeof s.stepType === 'string') types.add(s.stepType);
  });
  if (types.size === 0) return [];
  const params = new URLSearchParams();
  params.set('types', [...types].join(','));
  const info = await apiFetch<StepInfo[] | { data: StepInfo[] }>(
    client,
    `/workflows/steps/info?${params.toString()}`,
  );
  const items: StepInfo[] = Array.isArray(info) ? info : (info?.data ?? []);
  const knownTypes = new Set(items.map((i) => i.stepType));
  const issues: ValidationIssue[] = [];
  walkSteps(def.steps, '$.steps', (s, path) => {
    if (typeof s.stepType === 'string' && !knownTypes.has(s.stepType)) {
      issues.push({
        path: `${path}.stepType`,
        message: `unknown stepType "${s.stepType}" — not in the live step catalog`,
        code: 'unknown_step_type',
      });
    }
  });
  return issues;
}

function renderHuman(report: ValidationReport): void {
  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.error(colors.green('ok — validation passed'));
    return;
  }
  for (const e of report.errors) {
    console.error(`${colors.red('error')}  ${e.path}  ${e.message}  ${colors.dim(`[${e.code}]`)}`);
  }
  for (const w of report.warnings) {
    console.error(
      `${colors.yellow('warn')}   ${w.path}  ${w.message}  ${colors.dim(`[${w.code}]`)}`,
    );
  }
}

export interface WorkflowsValidateOptions {
  source?: string;
  fromStdin?: boolean;
  strict?: boolean;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsValidate(opts: WorkflowsValidateOptions): Promise<void> {
  const raw = readSource(opts.source, opts.fromStdin ?? false);
  let def: DefinitionLike;
  try {
    def = JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(
      `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'json_parse' },
    );
  }

  const report = localValidate(def);
  if (opts.strict) {
    const more = await strictValidate(opts.orgId, def);
    report.errors.push(...more);
    report.ok = report.errors.length === 0;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderHuman(report);
  }
  if (!report.ok) {
    throw new ValidationError(
      `validation failed: ${report.errors.length} error(s)`,
      { code: 'validation', details: report },
    );
  }
}
