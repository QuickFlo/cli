/**
 * Tests for form-trigger cross-reference rewriting (Phase 2): pull rewrites
 * workflow + connection id refs → names, push resolves names → target-org ids
 * (soft-drop on miss). Everything is name-keyed so a form trigger re-links its
 * prefill/confirmation/chat workflows and its form-auth credential connections
 * automatically when migrated to another org.
 */

import { assertEquals } from '@std/assert';
import {
  collectFormCredentialIds,
  collectFormCredentialNames,
  collectFormWorkflowIds,
  collectFormWorkflowNames,
  formRefsToIds,
  formRefsToNames,
} from './trigger-form-refs.ts';

type Obj = Record<string, unknown>;

function formConfig(form: Obj): Obj {
  return { form };
}

const PREFILL_ID = '11111111-1111-1111-1111-111111111111';
const CONFIRM_ID = '22222222-2222-2222-2222-222222222222';
const ENDED_ID = '33333333-3333-3333-3333-333333333333';

/** A pulled-from-source form config: refs are still ids. */
function sourceForm(): Obj {
  return formConfig({
    schema: { type: 'object' },
    prefill: { workflowId: PREFILL_ID, timeoutMs: 10000 },
    confirmation: { workflowId: CONFIRM_ID, timeoutMs: 5000 },
    mode: 'chat',
    chat: { historyDepth: 20, endedWorkflowId: ENDED_ID },
    auth: { provider: 'credentials', credentialIds: ['conn-a', 'conn-b'] },
  });
}

/** A serialized form config: refs are names (what lands in the file). */
function namedForm(): Obj {
  return formConfig({
    prefill: { workflowName: 'Prefill WF', timeoutMs: 10000 },
    confirmation: { workflowName: 'Confirm WF', timeoutMs: 5000 },
    chat: { endedWorkflowName: 'Ended WF' },
    auth: { provider: 'credentials', credentialNames: ['Acme Login', 'Beta Login'] },
  });
}

Deno.test('collect: gathers ids (pull) and names (push)', () => {
  assertEquals(
    collectFormWorkflowIds(sourceForm()).sort(),
    [PREFILL_ID, CONFIRM_ID, ENDED_ID].sort(),
  );
  assertEquals(collectFormCredentialIds(sourceForm()), ['conn-a', 'conn-b']);
  assertEquals(collectFormWorkflowNames(namedForm()).sort(), [
    'Confirm WF',
    'Ended WF',
    'Prefill WF',
  ]);
  assertEquals(collectFormCredentialNames(namedForm()), ['Acme Login', 'Beta Login']);
});

Deno.test('collect: non-form / wrong-provider configs yield nothing', () => {
  assertEquals(collectFormWorkflowIds({ webhook: {} }), []);
  assertEquals(collectFormCredentialIds(formConfig({ auth: { provider: 'none' } })), []);
  assertEquals(collectFormCredentialNames(formConfig({ auth: { provider: 'none' } })), []);
  assertEquals(collectFormWorkflowIds(undefined), []);
});

Deno.test('pull: rewrites workflow + connection ids → names in place', () => {
  const { config, warnings } = formRefsToNames(sourceForm(), {
    workflowIdToName: new Map([
      [PREFILL_ID, 'Prefill WF'],
      [CONFIRM_ID, 'Confirm WF'],
      [ENDED_ID, 'Ended WF'],
    ]),
    connectionIdToName: new Map([
      ['conn-a', 'Acme Login'],
      ['conn-b', 'Beta Login'],
    ]),
  });
  const form = (config as Obj)['form'] as Obj;

  assertEquals((form['prefill'] as Obj)['workflowName'], 'Prefill WF');
  assertEquals('workflowId' in (form['prefill'] as Obj), false);
  assertEquals((form['prefill'] as Obj)['timeoutMs'], 10000); // siblings preserved
  assertEquals((form['confirmation'] as Obj)['workflowName'], 'Confirm WF');
  assertEquals((form['chat'] as Obj)['endedWorkflowName'], 'Ended WF');
  assertEquals('endedWorkflowId' in (form['chat'] as Obj), false);
  assertEquals((form['auth'] as Obj)['credentialNames'], ['Acme Login', 'Beta Login']);
  assertEquals('credentialIds' in (form['auth'] as Obj), false);
  assertEquals(warnings.length, 0);
});

Deno.test('pull: unresolvable refs warn (workflow kept raw, connection dropped)', () => {
  const { config, warnings } = formRefsToNames(sourceForm(), {
    workflowIdToName: new Map(),
    connectionIdToName: new Map(),
  });
  const form = (config as Obj)['form'] as Obj;
  // Workflow ids are preserved raw; connection ids drop out of the name list.
  assertEquals((form['prefill'] as Obj)['workflowId'], PREFILL_ID);
  assertEquals((form['auth'] as Obj)['credentialNames'], []);
  // 3 workflow warnings + 2 connection warnings.
  assertEquals(warnings.length, 5);
});

Deno.test('pull: does not mutate the input config', () => {
  const src = sourceForm();
  formRefsToNames(src, {
    workflowIdToName: new Map([[PREFILL_ID, 'Prefill WF']]),
    connectionIdToName: new Map([['conn-a', 'Acme Login']]),
  });
  assertEquals(((src['form'] as Obj)['prefill'] as Obj)['workflowId'], PREFILL_ID);
  assertEquals(((src['form'] as Obj)['auth'] as Obj)['credentialIds'], ['conn-a', 'conn-b']);
});

Deno.test('push: resolves workflow + connection names → target-org ids', () => {
  const { config, warnings } = formRefsToIds(namedForm(), {
    workflowNameToId: new Map([
      ['Prefill WF', 'new-prefill'],
      ['Confirm WF', 'new-confirm'],
      ['Ended WF', 'new-ended'],
    ]),
    connectionNameToId: new Map([
      ['Acme Login', 'new-conn-a'],
      ['Beta Login', 'new-conn-b'],
    ]),
  });
  const form = (config as Obj)['form'] as Obj;

  assertEquals((form['prefill'] as Obj)['workflowId'], 'new-prefill');
  assertEquals('workflowName' in (form['prefill'] as Obj), false);
  assertEquals((form['confirmation'] as Obj)['workflowId'], 'new-confirm');
  assertEquals((form['chat'] as Obj)['endedWorkflowId'], 'new-ended');
  assertEquals((form['auth'] as Obj)['credentialIds'], ['new-conn-a', 'new-conn-b']);
  assertEquals('credentialNames' in (form['auth'] as Obj), false);
  assertEquals(warnings.length, 0);
});

Deno.test('push: unresolved prefill/confirmation dropped; chat cleared; missing creds filtered', () => {
  const { config, warnings } = formRefsToIds(namedForm(), {
    workflowNameToId: new Map([
      ['Prefill WF', null], // not in target org
      ['Confirm WF', 'new-confirm'],
      ['Ended WF', null],
    ]),
    connectionNameToId: new Map([
      ['Acme Login', 'new-conn-a'],
      ['Beta Login', null], // not migrated yet
    ]),
  });
  const form = (config as Obj)['form'] as Obj;

  assertEquals('prefill' in form, false); // required workflowId → drop block
  assertEquals((form['confirmation'] as Obj)['workflowId'], 'new-confirm');
  assertEquals('endedWorkflowName' in (form['chat'] as Obj), false);
  assertEquals('endedWorkflowId' in (form['chat'] as Obj), false);
  assertEquals((form['auth'] as Obj)['credentialIds'], ['new-conn-a']);
  assertEquals(warnings.some((w) => w.includes('Beta Login')), true);
  assertEquals(warnings.some((w) => w.includes('prefill')), true);
});

Deno.test('push: zero resolved credentials warns about server rejection', () => {
  const { config, warnings } = formRefsToIds(
    formConfig({ auth: { provider: 'credentials', credentialNames: ['Gone One', 'Gone Two'] } }),
    { workflowNameToId: new Map(), connectionNameToId: new Map() },
  );
  const auth = ((config as Obj)['form'] as Obj)['auth'] as Obj;
  assertEquals(auth['credentialIds'], []);
  assertEquals(warnings.some((w) => w.includes('at least one')), true);
});

Deno.test('push: a raw workflowId (no name) passes through untouched', () => {
  const { config } = formRefsToIds(
    formConfig({ prefill: { workflowId: 'literal-id', timeoutMs: 10000 } }),
    { workflowNameToId: new Map(), connectionNameToId: new Map() },
  );
  const prefill = ((config as Obj)['form'] as Obj)['prefill'] as Obj;
  assertEquals(prefill['workflowId'], 'literal-id');
});

Deno.test('roundtrip: source ids → names → target ids', () => {
  // Pull in source org.
  const pulled = formRefsToNames(sourceForm(), {
    workflowIdToName: new Map([
      [PREFILL_ID, 'Prefill WF'],
      [CONFIRM_ID, 'Confirm WF'],
      [ENDED_ID, 'Ended WF'],
    ]),
    connectionIdToName: new Map([['conn-a', 'Acme Login'], ['conn-b', 'Beta Login']]),
  });
  // Push to a different (target) org where the same names map to NEW ids.
  const pushed = formRefsToIds(pulled.config, {
    workflowNameToId: new Map([
      ['Prefill WF', 'tgt-prefill'],
      ['Confirm WF', 'tgt-confirm'],
      ['Ended WF', 'tgt-ended'],
    ]),
    connectionNameToId: new Map([['Acme Login', 'tgt-a'], ['Beta Login', 'tgt-b']]),
  });
  const form = (pushed.config as Obj)['form'] as Obj;
  assertEquals((form['prefill'] as Obj)['workflowId'], 'tgt-prefill');
  assertEquals((form['confirmation'] as Obj)['workflowId'], 'tgt-confirm');
  assertEquals((form['chat'] as Obj)['endedWorkflowId'], 'tgt-ended');
  assertEquals((form['auth'] as Obj)['credentialIds'], ['tgt-a', 'tgt-b']);
  assertEquals(pushed.warnings.length, 0);
});
