/**
 * Tests for the computed-field sync planner — the pure diff that decides what
 * `dashboards import` (and `calc-field`/`window-dim set`) writes to a target
 * source. The contract under test: match by name, create missing, update
 * drifted, skip identical, and NEVER produce a delete (target-only fields may
 * be referenced by other dashboards).
 */

import { assertEquals } from '@std/assert';
import { planComputedFieldSync } from './dashboards-source-fields.ts';
import type { CalculatedField, WindowDimension } from './dashboards-refs.ts';

const contacted = (formula: string): CalculatedField => ({
  name: 'contacted',
  label: 'Contacted',
  type: 'number',
  expression: { type: 'Literal', value: 1 },
  formula,
  measure: true,
});

const attempt: WindowDimension = {
  name: 'attempt',
  label: 'Attempt',
  function: 'row_number',
  partitionBy: ['DNIS'],
  orderBy: 'TIMESTAMP',
  direction: 'asc',
  semantic: 'lifetime',
};

Deno.test('creates fields missing on the target', () => {
  const plan = planComputedFieldSync(
    { calculatedFields: [contacted('IF(1, 1, 0)')], windowDimensions: [attempt] },
    {},
  );
  assertEquals(plan.map((a) => [a.family, a.action, a.name]), [
    ['calculated-field', 'create', 'contacted'],
    ['window-dimension', 'create', 'attempt'],
  ]);
});

Deno.test('skips fields whose definition already matches', () => {
  const plan = planComputedFieldSync(
    { calculatedFields: [contacted('IF(1, 1, 0)')], windowDimensions: [attempt] },
    {
      // Server records carry ids; they must not affect the comparison.
      calculatedFields: [{ ...contacted('IF(1, 1, 0)'), id: 'cf-1' }],
      windowDimensions: [{ ...attempt, id: 'wd-1' }],
    },
  );
  assertEquals(plan.map((a) => a.action), ['skip', 'skip']);
});

Deno.test('updates drifted definitions, carrying the target field id', () => {
  const plan = planComputedFieldSync(
    { calculatedFields: [contacted('IN(DISPOSITION, $ds.data_mapping.dispositions.is_sale)')] },
    { calculatedFields: [{ ...contacted('IF(1, 1, 0)'), id: 'cf-1' }] },
  );
  assertEquals(plan.length, 1);
  assertEquals(plan[0].action, 'update');
  assertEquals(plan[0].targetFieldId, 'cf-1');
});

Deno.test('never deletes target-only fields', () => {
  const plan = planComputedFieldSync(
    {},
    {
      calculatedFields: [{ ...contacted('IF(1, 1, 0)'), id: 'cf-1' }],
      windowDimensions: [{ ...attempt, id: 'wd-1' }],
    },
  );
  assertEquals(plan, []);
});

Deno.test('window dimension drift is detected (direction flip)', () => {
  const plan = planComputedFieldSync(
    { windowDimensions: [{ ...attempt, direction: 'desc' }] },
    { windowDimensions: [{ ...attempt, id: 'wd-1' }] },
  );
  assertEquals(plan.length, 1);
  assertEquals(plan[0].action, 'update');
  assertEquals(plan[0].targetFieldId, 'wd-1');
});

Deno.test('comparison ignores key order and undefined optionals', () => {
  const desired: WindowDimension = {
    orderBy: 'TIMESTAMP',
    name: 'attempt',
    partitionBy: ['DNIS'],
    label: 'Attempt',
    function: 'row_number',
    direction: 'asc',
    semantic: 'lifetime',
  };
  const plan = planComputedFieldSync(
    { windowDimensions: [desired] },
    { windowDimensions: [{ ...attempt, id: 'wd-1' }] },
  );
  assertEquals(plan.map((a) => a.action), ['skip']);
});
