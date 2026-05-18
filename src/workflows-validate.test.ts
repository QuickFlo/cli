/**
 * Smoke tests for the local (zero-network) validation path. These verify the
 * three semantic rules the CLI re-implements until @quickflo/schemas is
 * published. The strict (network) path is exercised manually against a real
 * org.
 */

import { assert, assertEquals } from '@std/assert';
import { runWorkflowsValidate } from './workflows-validate.ts';
import { ValidationError } from './errors.ts';

async function capture(json: Record<string, unknown>): Promise<{ ok: boolean; stdout: string }> {
  const tmp = await Deno.makeTempFile({ suffix: '.json' });
  await Deno.writeTextFile(tmp, JSON.stringify(json));
  const originalLog = console.log;
  const originalErr = console.error;
  let stdout = '';
  console.log = (...args: unknown[]) => {
    stdout += args.join(' ') + '\n';
  };
  console.error = () => {};
  try {
    await runWorkflowsValidate({ source: tmp, json: true });
    return { ok: true, stdout };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, stdout };
    throw err;
  } finally {
    console.log = originalLog;
    console.error = originalErr;
    await Deno.remove(tmp).catch(() => {});
  }
}

Deno.test('validate: minimal valid workflow passes', async () => {
  const res = await capture({ name: 'wf', steps: [{ id: 'a', stepType: 'http' }] });
  assert(res.ok, `expected ok, got: ${res.stdout}`);
});

Deno.test('validate: missing name fails', async () => {
  const res = await capture({ steps: [] });
  assertEquals(res.ok, false);
});

Deno.test('validate: missing steps array fails', async () => {
  const res = await capture({ name: 'wf' });
  assertEquals(res.ok, false);
});

Deno.test('validate: duplicate step ids fail', async () => {
  const res = await capture({
    name: 'wf',
    steps: [
      { id: 'a', stepType: 'http' },
      { id: 'a', stepType: 'http' },
    ],
  });
  assertEquals(res.ok, false);
});

Deno.test('validate: codeStep inside concurrent forEach fails', async () => {
  const res = await capture({
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
  assertEquals(res.ok, false);
});

Deno.test('validate: codeStep inside sequential forEach passes', async () => {
  const res = await capture({
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
  assert(res.ok);
});

Deno.test('validate: filter referencing unknown stepId fails', async () => {
  const res = await capture({
    name: 'wf',
    steps: [
      {
        id: 'a',
        stepType: 'http',
        config: { filters: [{ stepId: 'does-not-exist', output: 'x' }] },
      },
    ],
  });
  assertEquals(res.ok, false);
});

Deno.test('validate: filter referencing known stepId passes', async () => {
  const res = await capture({
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
  assert(res.ok);
});
