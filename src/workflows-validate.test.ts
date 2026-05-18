/**
 * Smoke tests for the local (zero-network) validation path. These verify the
 * three semantic rules the CLI re-implements until @quickflo/schemas is
 * published. The strict (network) path is exercised manually against a real
 * org.
 *
 * Tests call `localValidate` directly to avoid disk I/O — the file/stdin
 * source path is exercised end-to-end manually.
 */

import { assert, assertEquals } from '@std/assert';
import { localValidate } from './workflows-validate.ts';

Deno.test('validate: minimal valid workflow passes', () => {
  const r = localValidate({ name: 'wf', steps: [{ id: 'a', stepType: 'http' }] });
  assert(r.ok, `expected ok, got errors: ${JSON.stringify(r.errors)}`);
});

Deno.test('validate: missing name fails', () => {
  const r = localValidate({ steps: [] });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.path === '$.name'));
});

Deno.test('validate: missing steps array fails', () => {
  const r = localValidate({ name: 'wf' });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.path === '$.steps'));
});

Deno.test('validate: duplicate step ids fail', () => {
  const r = localValidate({
    name: 'wf',
    steps: [
      { id: 'a', stepType: 'http' },
      { id: 'a', stepType: 'http' },
    ],
  });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.code === 'duplicate_id'));
});

Deno.test('validate: codeStep inside concurrent forEach fails', () => {
  const r = localValidate({
    name: 'wf',
    steps: [
      {
        id: 'loop',
        stepType: 'forEach',
        config: {
          concurrency: 4,
          steps: [{ id: 'code', stepType: 'codeStep' }],
        },
      },
    ],
  });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.code === 'CodeStepInConcurrentForEach'));
});

Deno.test('validate: codeStep inside sequential forEach passes', () => {
  const r = localValidate({
    name: 'wf',
    steps: [
      {
        id: 'loop',
        stepType: 'forEach',
        config: {
          concurrency: 1,
          steps: [{ id: 'code', stepType: 'codeStep' }],
        },
      },
    ],
  });
  assert(r.ok, `expected ok, got errors: ${JSON.stringify(r.errors)}`);
});

Deno.test('validate: filter referencing unknown stepId fails', () => {
  const r = localValidate({
    name: 'wf',
    steps: [
      {
        id: 'a',
        stepType: 'http',
        config: { filters: [{ stepId: 'does-not-exist', output: 'x' }] },
      },
    ],
  });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.code === 'UnknownFilterRule'));
});

Deno.test('validate: filter referencing known stepId passes', () => {
  const r = localValidate({
    name: 'wf',
    steps: [
      { id: 'a', stepType: 'http' },
      {
        id: 'b',
        stepType: 'http',
        config: { filters: [{ stepId: 'a', output: 'x' }] },
      },
    ],
  });
  assert(r.ok, `expected ok, got errors: ${JSON.stringify(r.errors)}`);
});

Deno.test('validate: codeStep emits tier warning (not error)', () => {
  const r = localValidate({
    name: 'wf',
    steps: [{ id: 'a', stepType: 'codeStep' }],
  });
  assert(r.ok);
  assert(r.warnings.some((w) => w.code === 'CodeStepRequiresMediumTier'));
});
