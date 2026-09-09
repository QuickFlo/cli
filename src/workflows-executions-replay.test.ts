import { assertEquals } from '@std/assert';
import type { ApiClient } from './api.ts';
import { queueExecutionReplay } from './workflows-executions-replay.ts';

Deno.test('queueExecutionReplay delegates exact input recovery to the rerun endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Promise.resolve(
      new Response(JSON.stringify({ status: 'queued', executionId: 'new-execution' }), {
        status: 201,
      }),
    );
  };

  try {
    const client: ApiClient = {
      apiUrl: 'https://api.quickflo.test/api',
      accessToken: 'test-token',
      orgId: 'org-1',
    };

    const result = await queueExecutionReplay(client, 'source/execution');

    assertEquals(result, { status: 'queued', executionId: 'new-execution' });
    assertEquals(
      requestUrl,
      'https://api.quickflo.test/api/workflows/rerun/source%2Fexecution',
    );
    assertEquals(requestInit?.method, 'POST');
    assertEquals(requestInit?.body, undefined);
    const headers = new Headers(requestInit?.headers);
    assertEquals(headers.get('authorization'), 'Bearer test-token');
    assertEquals(headers.get('x-organization-id'), 'org-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
