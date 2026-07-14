/**
 * Shared contract for the server's validate endpoints.
 *
 * `POST /workflows/validate` and `POST /dashboards/validate` deliberately
 * return the same `{ ok, errors, warnings }` shape — only the anchor field
 * differs (`stepId` vs `widget`). Keeping the failure predicate in one place
 * means `--strict` can never come to mean two different things depending on
 * which resource you validated.
 */

export interface ValidationIssueBase {
  /** Stable rule identifier; agents may branch on it. */
  ruleId: string;
  severity: 'error' | 'warning';
  /** User-facing message: explains both the problem and the fix. */
  message: string;
}

export interface ValidationResultBase<I extends ValidationIssueBase> {
  ok: boolean;
  errors: I[];
  warnings: I[];
}

/** Pure: did validation fail, accounting for --strict (warnings count too)? */
export function validationFailed(
  result: { errors: unknown[]; warnings: unknown[] },
  strict: boolean,
): boolean {
  return result.errors.length > 0 || (strict && result.warnings.length > 0);
}
