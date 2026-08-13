import { assertEquals } from '@std/assert';
import { executionStreamLine } from './workflows-executions-tail.ts';

Deno.test('executionStreamLine emits exactly one compact JSON object per line', () => {
  const line = executionStreamLine({
    schemaVersion: 1,
    type: 'progress',
    executionId: 'exec-1',
    status: 'running',
    elapsedMs: 250,
    stepsExecuted: 2,
  });

  assertEquals(line.includes('\n'), false);
  assertEquals(JSON.parse(line), {
    schemaVersion: 1,
    type: 'progress',
    executionId: 'exec-1',
    status: 'running',
    elapsedMs: 250,
    stepsExecuted: 2,
  });
});
