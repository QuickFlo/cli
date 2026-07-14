/**
 * Tests for the check command's pure logic. Validation itself is server-side
 * (POST /dashboards/validate); the network path is exercised against a real
 * org. Here we assert the two things the CLI genuinely owns: mapping a
 * dashboard file to the validate payload, and how --strict turns the server's
 * { errors, warnings } into a pass/fail outcome.
 */

import { assertEquals } from '@std/assert';
import { type DashboardValidationResult, toValidatePayload } from './dashboards-check.ts';
import { validationFailed } from './validation-result.ts';

function result(errors: number, warnings: number): DashboardValidationResult {
  const mk = (severity: 'error' | 'warning') => ({
    ruleId: 'field-refs',
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

Deno.test('maps a pulled dashboard file to the validate payload', () => {
  const payload = toValidatePayload({
    name: 'Ops',
    widgets: [
      {
        id: 'a1b2',
        title: 'Calls by campaign',
        chartType: 'bar',
        dataSourceId: 'ds_abc',
        queryConfig: { dimensions: ['ds_abc.CAMPAIGN TYPE'] },
        displayConfig: { legend: true },
      },
    ],
  });

  assertEquals(payload.widgets, [
    {
      id: 'a1b2',
      title: 'Calls by campaign',
      dataSourceId: 'ds_abc',
      queryConfig: { dimensions: ['ds_abc.CAMPAIGN TYPE'] },
    },
  ]);
});

Deno.test('omits id and title when the file has none', () => {
  const payload = toValidatePayload({
    widgets: [{ dataSourceId: 'ds_abc', queryConfig: {} }],
  });
  assertEquals(payload.widgets, [{ dataSourceId: 'ds_abc', queryConfig: {} }]);
});

// A widget with no queryConfig is legal in a file; the server decides whether
// that is a finding, not the CLI.
Deno.test('defaults a missing queryConfig to an empty object', () => {
  const payload = toValidatePayload({
    widgets: [{ title: 'Bare', dataSourceId: 'ds_abc' }],
  });
  assertEquals(payload.widgets[0]?.queryConfig, {});
});

// Do not silently drop a widget missing its dataSourceId — forward it so the
// server reports it. Dropping it would let the very mistake `check` exists to
// catch pass unmentioned.
Deno.test('forwards a widget missing dataSourceId rather than dropping it', () => {
  const payload = toValidatePayload({ widgets: [{ title: 'Orphan' }] });
  assertEquals(payload.widgets.length, 1);
  assertEquals(payload.widgets[0]?.dataSourceId, '');
});

Deno.test('yields no widgets for a file without a widgets array', () => {
  assertEquals(toValidatePayload({ name: 'Empty' }).widgets, []);
});
