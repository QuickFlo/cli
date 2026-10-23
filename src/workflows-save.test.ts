/**
 * Tests for the shared workflow save helpers extracted from workflows-push.ts
 * (used by both `push` and the MCP `save_workflow_draft` tool). Pure payload
 * shaping only — the network upsert is exercised manually.
 */

import { assert, assertEquals } from '@std/assert';
import { buildDefinition, buildWorkflowFileShape, buildWorkflowPayload } from './workflows-save.ts';

Deno.test('buildDefinition nests steps/initial/environment/options', () => {
  const def = buildDefinition({
    name: 'wf',
    steps: [{ stepId: 'a', stepType: 'core.http' }],
    initial: { x: 1 },
    environment: 'prod',
    options: { workerTier: 'medium' },
  });
  assertEquals(def['steps'], [{ stepId: 'a', stepType: 'core.http' }]);
  assertEquals(def['initial'], { x: 1 });
  assertEquals(def['environment'], 'prod');
  assertEquals(def['options'], { workerTier: 'medium' });
});

Deno.test('buildDefinition omits absent optional fields', () => {
  const def = buildDefinition({ name: 'wf', steps: [] });
  assertEquals(def['steps'], []);
  assert(!('initial' in def));
  assert(!('environment' in def));
  assert(!('options' in def));
});

Deno.test('buildWorkflowPayload nests definition fields and passes through metadata', () => {
  const payload = buildWorkflowPayload({
    name: 'wf',
    steps: [{ stepId: 'a', stepType: 'core.http' }],
    initial: { x: 1 },
    description: 'hi',
    isTemplate: true,
    tags: ['tool'],
  });
  assertEquals(payload['name'], 'wf');
  assertEquals(payload['description'], 'hi');
  assertEquals(payload['isTemplate'], true);
  assertEquals(payload['tags'], ['tool']);
  const definition = payload['definition'] as Record<string, unknown>;
  assertEquals(definition['steps'], [{ stepId: 'a', stepType: 'core.http' }]);
  assertEquals(definition['initial'], { x: 1 });
  // flattened definition fields must not also appear at the top level
  assert(!('steps' in payload));
  assert(!('initial' in payload));
});

Deno.test('buildWorkflowPayload strips server-managed fields and id', () => {
  const payload = buildWorkflowPayload({
    id: 'abc',
    name: 'wf',
    steps: [],
    organizationId: 'org-1',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    userId: 'u1',
    usedActionTypes: ['core.http'],
  });
  for (const k of ['id', 'organizationId', 'createdAt', 'updatedAt', 'userId', 'usedActionTypes']) {
    assert(!(k in payload), `expected "${k}" to be stripped`);
  }
});

Deno.test('authored schemas and tool metadata survive save/get/pull/save', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      profile: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: false },
          labels: { type: 'array', items: { enum: ['first', 'second'] } },
          limit: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
        },
        required: ['enabled'],
      },
    },
    required: ['profile'],
    additionalProperties: false,
  };
  const source = {
    name: 'five9-tool',
    steps: [{ stepId: 'call', stepType: 'five9.modify-campaign-profile' }],
    initial: {},
    inputSchema,
    isTemplate: true,
    tags: ['tool', 'five9'],
    options: { workerTier: 'standard' },
    agentToolMetadata: { requiresApproval: true },
  };
  const payload = buildWorkflowPayload(source);
  assertEquals((payload['definition'] as Record<string, unknown>)['inputSchema'], inputSchema);
  assert(!('inputSchema' in payload));
  const file = buildWorkflowFileShape({ ...payload, id: 'saved', organizationId: 'org' });
  assertEquals(file['inputSchema'], inputSchema);
  assertEquals(file['agentToolMetadata'], source.agentToolMetadata);
  assertEquals(file['tags'], source.tags);
  assertEquals(file['options'], source.options);
  assert(!('organizationId' in file));
  assertEquals(buildWorkflowPayload({ ...file, name: source.name, steps: source.steps }), payload);
});

Deno.test('explicit empty input schema survives serialization without opting legacy files in', () => {
  const payload = buildWorkflowPayload({ name: 'empty', steps: [], inputSchema: {} });
  assertEquals(buildWorkflowFileShape(payload)['inputSchema'], {});
  assert(
    !('inputSchema' in buildWorkflowFileShape(buildWorkflowPayload({ name: 'legacy', steps: [] }))),
  );
});
