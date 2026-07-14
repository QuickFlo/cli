/**
 * `quickflo dashboards check <file>|--from-stdin` (alias: `validate`) —
 * validate a dashboard file's widgets WITHOUT saving them.
 *
 * Thin client, same contract as `workflows validate`: all rules live server-side
 * at `POST /dashboards/validate`, so this CLI, the in-app agent, and the MCP
 * server give identical answers. The CLI ships no field catalog and
 * reimplements no rules — it reads the file, posts the widgets, renders the
 * `{ ok, errors, warnings }` result.
 *
 * Why it exists: the analytics engine fails SILENTLY on a bad field ref. A
 * missing JSONB key reads as NULL (Postgres) / '' (ClickHouse), so a typo'd
 * `ds_x.CAMPAIGN_TYPE` (underscore) where the schema key is `CAMPAIGN TYPE`
 * (space) matches zero rows and never raises — the widget just renders empty.
 * `check` is the only place that mistake becomes visible before it ships, and
 * the server answers with a "did you mean" suggestion.
 *
 * Takes the same file shape `dashboards pull` writes and `dashboards push`
 * reads, so the loop is: pull -> edit -> check -> push.
 *
 * Exit: 3 on validation errors, or — with `--strict` — any warnings.
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

export interface DashboardValidationIssue extends ValidationIssueBase {
  /** Widget the issue is anchored to (title or id). */
  widget?: string;
}

export type DashboardValidationResult = ValidationResultBase<DashboardValidationIssue>;

/** The subset of a dashboard file that validation reads. */
interface DashboardFileLike {
  name?: string;
  widgets?: Array<Record<string, unknown>>;
}

/** A widget as `POST /dashboards/validate` accepts it. */
export interface ValidatableWidgetPayload {
  id?: string;
  title?: string;
  dataSourceId: string;
  queryConfig: Record<string, unknown>;
}

/**
 * Pure: map a dashboard file's widgets to the validate payload. Keeps `id` and
 * `title` when present purely so the server can anchor each finding to a
 * widget the reader can locate in their file.
 */
export function toValidatePayload(
  file: DashboardFileLike,
): { widgets: ValidatableWidgetPayload[] } {
  const widgets = (file.widgets ?? []).map((w) => {
    const id = w['id'];
    const title = w['title'];
    const dataSourceId = w['dataSourceId'];
    return {
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof title === 'string' ? { title } : {}),
      dataSourceId: typeof dataSourceId === 'string' ? dataSourceId : '',
      queryConfig: (w['queryConfig'] ?? {}) as Record<string, unknown>,
    };
  });
  return { widgets };
}

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
    throw new UserError('Pass a dashboard file path or --from-stdin.');
  }
  return Deno.readTextFileSync(source);
}

function formatIssue(issue: DashboardValidationIssue): string {
  const where = issue.widget ? colors.dim(`[${issue.widget}] `) : '';
  return `${where}${issue.message} ${colors.dim(`(${issue.ruleId})`)}`;
}

function renderHuman(result: DashboardValidationResult, strict: boolean): void {
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

export interface DashboardsCheckOptions {
  source?: string;
  fromStdin?: boolean;
  strict?: boolean;
  orgId?: string;
  apiUrl?: string;
  json?: boolean;
}

export async function runDashboardsCheck(
  opts: DashboardsCheckOptions,
): Promise<void> {
  const raw = readSource(opts.source, opts.fromStdin ?? false);
  let file: DashboardFileLike;
  try {
    file = JSON.parse(raw) as DashboardFileLike;
  } catch (err) {
    throw new ValidationError(
      `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      { code: 'json_parse' },
    );
  }

  const payload = toValidatePayload(file);
  if (payload.widgets.length === 0) {
    throw new UserError(
      'No widgets found in the file. Expected a dashboard file with a `widgets` array (as written by `dashboards pull`).',
    );
  }

  const { client } = await openSession({ orgId: opts.orgId }, 'dashboards check');
  const result = await apiFetch<DashboardValidationResult>(
    client,
    '/dashboards/validate',
    { method: 'POST', body: JSON.stringify(payload) },
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
