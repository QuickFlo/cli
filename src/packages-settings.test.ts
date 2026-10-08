import { assert, assertEquals, assertRejects } from '@std/assert';
import type { ApiClient } from './api.ts';
import { ApiError } from './errors.ts';
import {
  type PackagesSettingsDependencies,
  type PackagesSettingsOptions,
  runPackagesSettings,
} from './packages-settings.ts';

const client: ApiClient = { apiUrl: 'https://api.example.test', accessToken: 'test', orgId: 'org' };
const mutation = {
  key: 'config',
  packageVersionId: '00000000-0000-4000-8000-000000000001',
  revision: 'original',
  changes: [
    { operation: 'set', path: '/dryRun', value: false },
    { operation: 'set', path: '/limit', value: 0 },
    { operation: 'remove', path: '/optional' },
  ],
};

function harness(
  response: (path: string, init: RequestInit) => unknown = () => ({ records: [], hasMore: false }),
  input: unknown = mutation,
  confirmed = true,
) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const confirmations: (boolean | undefined)[] = [];
  const deps: PackagesSettingsDependencies = {
    openSession: () =>
      Promise.resolve({
        client,
        org: { id: 'org', name: 'Test' },
        apiUrl: client.apiUrl,
        profileName: 'test',
      }),
    apiFetch: <T>(actual: ApiClient, path: string, init: RequestInit = {}) => {
      assertEquals(actual, client);
      calls.push({
        path,
        method: init.method ?? 'GET',
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Promise.resolve(response(path, init) as T);
    },
    readTextFile: () => Promise.resolve(JSON.stringify(input)),
    confirmDestructive: (_question, yes) => {
      confirmations.push(yes);
      return Promise.resolve(confirmed);
    },
  };
  async function run(opts: PackagesSettingsOptions) {
    const output: unknown[] = [];
    const log = console.log;
    console.log = (value: string) => output.push(JSON.parse(value));
    try {
      await runPackagesSettings(opts, deps);
    } finally {
      console.log = log;
    }
    return output;
  }
  return { calls, confirmations, run };
}

Deno.test('settings describe returns the installed contract unchanged, using an encoded install id', async () => {
  const description = {
    packageVersionId: 'pinned',
    sources: [{ id: 'source', tableName: 'aliased', settings: { writablePaths: ['/a'] } }],
  };
  const h = harness(() => description);
  assertEquals(await h.run({ action: 'describe', installId: 'id/?', json: true }), [description]);
  assertEquals(h.calls, [{ path: '/package-installs/id%2F%3F/settings', method: 'GET' }]);
});

Deno.test('published declarations are retrieved by publisher package id and exact semver', async () => {
  const sources = { sources: { config: { title: 'Config', writablePaths: ['/a'] } } };
  const h = harness(() => sources);
  assertEquals(await h.run({ action: 'published', packageId: 'pkg', version: '1.0.0+build' }), [
    sources,
  ]);
  assertEquals(h.calls[0].path, '/packages/pkg/versions/1.0.0%2Bbuild/settings');
});

Deno.test('records preserve projected values, revisions, issues and the single-page hasMore flag', async () => {
  const page = {
    records: [{
      key: 'a',
      value: { flag: false },
      revision: 'r',
      issues: [{ path: '/n', message: 'invalid' }],
    }],
    hasMore: true,
  };
  const h = harness(() => page);
  assertEquals(await h.run({ action: 'records', installId: 'i', sourceId: 's' }), [page]);
  assertEquals(h.calls.length, 1);
});

Deno.test('records --all follows key cursors and preserves every revision', async () => {
  const first = { key: 'a&/b', value: { n: 0 }, revision: 'r1', issues: [] };
  const second = { key: 'z', value: { n: 1 }, revision: 'r2', issues: [] };
  const h = harness((path) => {
    const query = new URL(path, client.apiUrl).searchParams;
    return query.get('afterKey') === first.key
      ? { records: [second], hasMore: false }
      : { records: [first], hasMore: true };
  });
  assertEquals(await h.run({ action: 'records', installId: 'i', sourceId: 's/a', all: true }), [{
    records: [first, second],
    hasMore: false,
  }]);
  assert(h.calls[1].path.startsWith('/package-installs/i/settings/s%2Fa/records?'));
  assertEquals(new URL(h.calls[1].path, client.apiUrl).searchParams.get('afterKey'), first.key);
});

Deno.test('records support exact keys and manual pagination without losing escaping', async () => {
  for (const filter of [{ key: 'a &/?' }, { afterKey: 'a &/?' }]) {
    const h = harness();
    await h.run({ action: 'records', installId: 'i', sourceId: 's', ...filter });
    const [name, value] = Object.entries(filter)[0];
    assertEquals(new URL(h.calls[0].path, client.apiUrl).searchParams.get(name), value);
  }
});

Deno.test('records stop on stalled pagination instead of looping or silently returning partial results', async () => {
  for (const records of [[], [{ key: 'same', value: {}, revision: 'r', issues: [] }]]) {
    const h = harness(() => ({ records, hasMore: true }));
    await assertRejects(
      () => h.run({ action: 'records', installId: 'i', sourceId: 's', all: true }),
      Error,
      'did not advance',
    );
    assert(h.calls.length <= 2);
  }
});

Deno.test('dynamic options pass pointer, search, cursor and selected value without changing disabled options', async () => {
  const result = { items: [{ value: 'Old', label: 'Old', disable: true }], nextCursor: '50' };
  const h = harness(() => result);
  assertEquals(
    await h.run({
      action: 'options',
      installId: 'i',
      sourceId: 's',
      path: '/a~1b',
      search: 'x&y',
      cursor: 50,
      selected: 'Old',
    }),
    [result],
  );
  assertEquals(Object.fromEntries(new URL(h.calls[0].path, client.apiUrl).searchParams), {
    path: '/a~1b',
    search: 'x&y',
    cursor: '50',
    selected: 'Old',
  });
});

Deno.test('save posts only the explicit changes and original concurrency tokens', async () => {
  const h = harness();
  await h.run({ action: 'save', installId: 'i', sourceId: 's', file: 'changes.json' });
  assertEquals(h.calls, [{
    path: '/package-installs/i/settings/s/records',
    method: 'POST',
    body: mutation,
  }]);
  assertEquals(h.confirmations, []);
});

Deno.test('creation forwards a null revision without fetching/replacing the record', async () => {
  const body = { ...mutation, revision: null };
  const h = harness(undefined, body);
  await h.run({ action: 'save', installId: 'i', sourceId: 's', file: 'changes.json' });
  assertEquals(h.calls.map((call) => call.body), [body]);
});

Deno.test('save propagates validation and concurrency errors without retries', async () => {
  for (const status of [400, 403, 409]) {
    const error = new ApiError(status, '/settings', 'failure', {
      details: { code: 'settings-conflict' },
    });
    const h = harness(() => {
      throw error;
    });
    const actual = await assertRejects(
      () => h.run({ action: 'save', installId: 'i', sourceId: 's', file: 'changes.json' }),
      ApiError,
    );
    assertEquals(actual, error);
    assertEquals(h.calls.length, 1);
  }
});

Deno.test('save/delete dry runs display the exact request without writes or confirmations', async () => {
  for (const action of ['save', 'delete'] as const) {
    const body = action === 'save' ? mutation : { key: 'k', packageVersionId: 'v', revision: 'r' };
    const h = harness(undefined, body);
    assertEquals(
      await h.run({ action, installId: 'i', sourceId: 's', file: 'changes.json', dryRun: true }),
      [{
        dryRun: true,
        method: 'POST',
        path: `/package-installs/i/settings/s/records${action === 'delete' ? '/delete' : ''}`,
        body,
      }],
    );
    assertEquals(h.calls, []);
    assertEquals(h.confirmations, []);
  }
});

Deno.test('delete honors confirmation and sends the supplied version/revision', async () => {
  const body = { key: 'k', packageVersionId: 'v', revision: 'r' };
  const declined = harness(undefined, body, false);
  await declined.run({ action: 'delete', installId: 'i', sourceId: 's', file: 'delete.json' });
  assertEquals(declined.calls, []);
  const h = harness(() => ({ deleted: true }), body);
  assertEquals(
    await h.run({
      action: 'delete',
      installId: 'i',
      sourceId: 's',
      file: 'delete.json',
      yes: true,
    }),
    [{ deleted: true }],
  );
  assertEquals(h.confirmations, [true]);
  assertEquals(h.calls, [{
    path: '/package-installs/i/settings/s/records/delete',
    method: 'POST',
    body,
  }]);
});

Deno.test('malformed mutation envelopes fail before an API call', async () => {
  for (
    const input of [[], {}, { ...mutation, revision: undefined }, { ...mutation, revision: '' }, {
      ...mutation,
      changes: [],
    }, { ...mutation, value: {} }]
  ) {
    const h = harness(undefined, input);
    await assertRejects(() =>
      h.run({ action: 'save', installId: 'i', sourceId: 's', file: 'bad.json' })
    );
    assertEquals(h.calls, []);
  }
  const h = harness(undefined, { key: 'k', packageVersionId: 'v', revision: null });
  await assertRejects(
    () => h.run({ action: 'delete', installId: 'i', sourceId: 's', file: 'bad.json' }),
    Error,
    'revision',
  );
  assertEquals(h.calls, []);
  assertEquals(h.confirmations, []);
});
