import { assertEquals, assertRejects } from '@std/assert';
import { fetchWorkflowStepLibrary, type WorkflowStepLibrary } from './workflows-steps.ts';
import { ApiError } from './errors.ts';

const client = { apiUrl: 'https://fixture.invalid', accessToken: 'test-token', orgId: 'org-a' };

Deno.test('workflow step discovery keeps exact server identities, versions and missing exports', async () => {
  const library: WorkflowStepLibrary = {
    workspace: [{
      workflowId: 'local',
      workflowName: 'greet',
      displayName: 'Greet',
      icon: null,
      revision: '1',
    }],
    items: [{
      workflowId: 'installed',
      workflowName: 'greet',
      displayName: 'Greet',
      group: 'Greetings',
      icon: 'https://fixture.invalid/icon.svg',
      packageInstallId: 'install',
      packageName: 'Fixture',
      packageSlug: 'fixture',
      packageVersion: '2.0.0',
    }],
    unavailable: [{ packageInstallId: 'install', packageName: 'Fixture', workflowName: 'removed' }],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assertEquals(String(url), 'https://fixture.invalid/workflows/library/steps');
    const headers = new Headers(init?.headers);
    assertEquals(headers.get('x-organization-id'), 'org-a');
    assertEquals(headers.get('Authorization'), 'Bearer test-token');
    return Promise.resolve(Response.json(library));
  };
  try {
    assertEquals(await fetchWorkflowStepLibrary(client), library);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('workflow library errors propagate without falling back to native or same-name workflows', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.resolve(Response.json({ message: 'Library unavailable' }, { status: 404 }));
  };
  try {
    await assertRejects(() => fetchWorkflowStepLibrary(client), ApiError, 'Library unavailable');
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
