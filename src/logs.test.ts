import { assertEquals, assertObjectMatch, assertThrows } from '@std/assert';
import { buildSearchBody, type LogsSearchOptions } from './logs.ts';
import { UserError } from './errors.ts';

Deno.test('buildSearchBody: empty options → empty body (server applies defaults)', () => {
  assertEquals(buildSearchBody({}), {});
});

Deno.test('buildSearchBody: repeatable + CSV flags coalesce into arrays', () => {
  const body = buildSearchBody({
    source: ['workflow', 'trigger,audit'],
    level: ['warn,error'],
    channel: ['list-sync'],
    tag: ['five9', 'bulk,retry'],
  });
  assertEquals(body.sources, ['workflow', 'trigger', 'audit']);
  assertEquals(body.level, ['warn', 'error']);
  assertEquals(body.channels, ['list-sync']);
  assertEquals(body.tags, ['five9', 'bulk', 'retry']);
});

Deno.test('buildSearchBody: invalid enum values throw UserError', () => {
  assertThrows(() => buildSearchBody({ source: ['nope'] }), UserError, '--source');
  assertThrows(() => buildSearchBody({ level: ['fatal'] }), UserError, '--level');
});

Deno.test('buildSearchBody: correlators map to exact-match fields', () => {
  const body = buildSearchBody({
    workflow: 'wf-1',
    execution: 'ex-1',
    connection: 'cn-1',
    connectionName: 'Salesforce',
    trigger: 'tr-1',
    instance: 'in-1',
    id: 'deadbeef',
  });
  assertObjectMatch(body, {
    workflowId: 'wf-1',
    executionId: 'ex-1',
    connectionId: 'cn-1',
    connectionName: 'Salesforce',
    triggerId: 'tr-1',
    instanceId: 'in-1',
    id: 'deadbeef',
  });
});

Deno.test('buildSearchBody: --search terms pass through as text[]', () => {
  assertEquals(buildSearchBody({ search: ['synced', 'DELETE'] }).text, ['synced', 'DELETE']);
});

Deno.test('buildSearchBody: --data parses on the first colon only', () => {
  const body = buildSearchBody({ data: ['status:500', 'url:https://x.io/a:b'] });
  assertEquals(body.dataFilters, [
    { path: 'status', value: '500' },
    { path: 'url', value: 'https://x.io/a:b' },
  ]);
});

Deno.test('buildSearchBody: malformed --data throws', () => {
  assertThrows(() => buildSearchBody({ data: ['nocolon'] }), UserError, '--data');
  assertThrows(() => buildSearchBody({ data: [':leading'] }), UserError, '--data');
});

Deno.test('buildSearchBody: --since becomes an ISO `from` in the past', () => {
  const body = buildSearchBody({ since: '1h' });
  const from = new Date(body.from ?? '').getTime();
  const delta = Date.now() - from;
  // ~1h ago, allow generous slack for test execution time.
  if (delta < 59 * 60_000 || delta > 61 * 60_000) {
    throw new Error(`--since 1h produced from=${body.from} (delta ${delta}ms)`);
  }
});

Deno.test('buildSearchBody: explicit --from overrides --since', () => {
  const opts: LogsSearchOptions = {
    since: '1d',
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
  };
  const body = buildSearchBody(opts);
  assertEquals(body.from, '2026-01-01T00:00:00Z');
  assertEquals(body.to, '2026-01-02T00:00:00Z');
});

Deno.test('buildSearchBody: invalid --since duration throws', () => {
  assertThrows(() => buildSearchBody({ since: 'soon' }), UserError);
});
