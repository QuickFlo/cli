import { assertEquals } from '@std/assert';
import {
  buildWorkflowRunResult,
  extractReturnResponseBody,
  findSuccessfulReturnStep,
} from './workflow-run-result.ts';

Deno.test('findSuccessfulReturnStep finds an executed nested core.return', () => {
  const found = findSuccessfulReturnStep({
    'if-route': {
      s: 's',
      t: 'core.if',
      n: {
        'return-ok': { s: 's', t: 'core.return' },
        'return-skipped': { s: 'k', t: 'core.return' },
      },
    },
  }, {
    'return-ok': 'if-route/return-ok',
    'return-skipped': 'if-route/return-skipped',
  });

  assertEquals(found, { stepId: 'return-ok', stepPath: 'if-route/return-ok' });
});

Deno.test('extractReturnResponseBody mirrors webhook response precedence', () => {
  assertEquals(
    extractReturnResponseBody({
      $input: {},
      $meta: { stepType: 'core.return' },
      webhookResponse: { body: { accepted: true }, statusCode: 202 },
    }),
    { accepted: true },
  );
  assertEquals(
    extractReturnResponseBody({
      $input: {},
      $meta: { stepType: 'core.return' },
      count: 3,
      items: ['a', 'b', 'c'],
      statusCode: 200,
      formSubmission: false,
    }),
    { count: 3, items: ['a', 'b', 'c'] },
  );
});

Deno.test('buildWorkflowRunResult restores one stable finite-command envelope', () => {
  assertEquals(
    buildWorkflowRunResult({
      id: 'exec-1',
      workflowId: 'wf-1',
      workflowName: 'Example',
      status: 'success',
      durationMilliseconds: 42,
      error: null,
    }, { answer: 42 }),
    {
      schemaVersion: 1,
      executionId: 'exec-1',
      workflowId: 'wf-1',
      workflowName: 'Example',
      status: 'success',
      success: true,
      durationMilliseconds: 42,
      output: { answer: 42 },
      error: null,
    },
  );
});
