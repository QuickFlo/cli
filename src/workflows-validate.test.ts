/**
 * Tests for the validate command's pure failure-decision logic. Validation
 * itself is server-side (POST /workflows/validate); the network path is
 * exercised manually against a real org. Here we only assert how `--strict`
 * turns the server's { errors, warnings } into a pass/fail outcome.
 */

import { assertEquals } from '@std/assert';
import { validationFailed, type ValidationResult } from './workflows-validate.ts';

function result(
  errors: number,
  warnings: number,
): ValidationResult {
  const mk = (severity: 'error' | 'warning') => ({
    ruleId: 'test',
    severity,
    message: 'x',
  });
  return {
    ok: errors === 0,
    errors: Array.from({ length: errors }, () => mk('error')),
    warnings: Array.from({ length: warnings }, () => mk('warning')),
  };
}

Deno.test('clean result never fails', () => {
  assertEquals(validationFailed(result(0, 0), false), false);
  assertEquals(validationFailed(result(0, 0), true), false);
});

Deno.test('errors always fail, strict or not', () => {
  assertEquals(validationFailed(result(2, 0), false), true);
  assertEquals(validationFailed(result(2, 0), true), true);
});

Deno.test('warnings fail only under --strict', () => {
  assertEquals(validationFailed(result(0, 3), false), false);
  assertEquals(validationFailed(result(0, 3), true), true);
});
