/**
 * `quickflo workflows validate <file>|--from-stdin` (alias: `check`) —
 * validate a workflow definition WITHOUT saving or running it.
 *
 * Thin client: all validation happens server-side at `POST /workflows/validate`
 * (the server's Zod + rules are the single source of truth). The CLI ships no
 * step schemas and reimplements no rules — it reads JSON, posts it, and renders
 * the `{ ok, errors, warnings }` result.
 *
 * The server reports: undefined / forward step references, unknown Liquid
 * filters, unknown output fields, worker-tier problems, and references to
 * connections that don't exist in the org (warning). It never flags templated
 * values on type grounds (Liquid resolves types at runtime).
 *
 * Exit: non-zero if there are errors, or — with `--strict` — any warnings.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { UserError, ValidationError } from './errors.ts';
import {
  validationFailed,
  type ValidationIssueBase,
  type ValidationResultBase,
} from './validation-result.ts';

export interface ValidationIssue extends ValidationIssueBase {
  /** Step the issue is anchored to, if applicable. */
  stepId?: string;
}

export type ValidationResult = ValidationResultBase<ValidationIssue>;

// Re-exported: the predicate is shared with `dashboards check` so --strict
// means exactly one thing across both. Existing importers keep working.
export { validationFailed };

function readAllSync(reader: {
  readSync(p: Uint8Array): number | null;
}): Uint8Array {
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

function readSource(source: string | undefined, fromStdin: boolean): string {
  if (fromStdin) return new TextDecoder().decode(readAllSync(Deno.stdin));
  if (!source) {
    throw new UserError('Pass a file path or --from-stdin.');
  }
  return Deno.readTextFileSync(source);
}

function formatIssue(issue: ValidationIssue): string {
  const where = issue.stepId ? colors.dim(`[${issue.stepId}] `) : '';
  return `${where}${issue.message} ${colors.dim(`(${issue.ruleId})`)}`;
}

function renderHuman(result: ValidationResult, strict: boolean): void {
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.error(colors.green('ok: validation passed'));
    return;
  }
  for (const e of result.errors) {
    console.error(`${colors.red('error')}  ${formatIssue(e)}`);
  }
  for (const w of result.warnings) {
    const label = strict ? colors.red('warn!') : colors.yellow('warn ');
    console.error(`${label}  ${formatIssue(w)}`);
  }
  console.error(
    colors.dim(
      `\n${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
    ),
  );
}

export interface WorkflowsValidateOptions {
  source?: string;
  fromStdin?: boolean;
  strict?: boolean;
  orgId?: string;
  apiUrl?: string;
  json?: boolean;
}

export async function runWorkflowsValidate(
  opts: WorkflowsValidateOptions,
): Promise<void> {
  const raw = readSource(opts.source, opts.fromStdin ?? false);
  let def: unknown;
  try {
    def = JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(
      `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'json_parse' },
    );
  }

  const { client } = await openSession(
    { orgId: opts.orgId },
    'workflows validate',
  );
  const result = await apiFetch<ValidationResult>(
    client,
    '/workflows/validate',
    { method: 'POST', body: JSON.stringify(def) },
  );

  const strict = opts.strict ?? false;
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    renderHuman(result, strict);
  }

  if (validationFailed(result, strict)) {
    throw new ValidationError(
      `validation failed: ${result.errors.length} error(s)` +
        (strict ? `, ${result.warnings.length} warning(s)` : ''),
      { code: 'validation', details: result },
    );
  }
}
