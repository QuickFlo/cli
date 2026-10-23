import { assertEquals, assertStringIncludes } from '@std/assert';
import { buildWorkflowFileShape, buildWorkflowPayload } from './workflows-save.ts';
import { AGENT_GUIDE, BUILDING_WORKFLOWS } from './skill-guides.ts';

Deno.test('Step capability and presentation survive push/get/pull/push serialization', () => {
  const source = {
    name: 'greet-person',
    isTemplate: true,
    tags: ['step', 'tool', 'read'],
    uiMetadata: {
      step: { group: 'Greetings', displayName: 'Greet person' },
      nodePositions: { result: { x: 1, y: 2 } },
    },
    agentToolMetadata: { requiresApproval: true },
    initial: { name: 'string: Person to greet' },
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    steps: [{
      stepId: 'result',
      stepType: 'core.return',
      input: { greeting: 'Hello {{ initial.name }}' },
    }],
  };
  const payload = buildWorkflowPayload(source);
  assertEquals(payload['uiMetadata'], source.uiMetadata);
  assertEquals(payload['tags'], source.tags);
  const file = buildWorkflowFileShape({ ...payload, id: 'saved', organizationId: 'org' });
  assertEquals(file['uiMetadata'], source.uiMetadata);
  assertEquals(file['isTemplate'], true);
  assertEquals(buildWorkflowPayload({ ...file, name: source.name, steps: source.steps }), payload);
  const defaults = buildWorkflowPayload({ ...source, uiMetadata: { step: {} } });
  assertEquals(buildWorkflowFileShape(defaults)['uiMetadata'], { step: {} });
});

Deno.test('guides embedded for skill install and MCP include the canonical Step authoring contract', async () => {
  assertEquals(
    BUILDING_WORKFLOWS,
    await Deno.readTextFile(new URL('../skill/building-workflows.md', import.meta.url)),
  );
  assertEquals(
    AGENT_GUIDE,
    await Deno.readTextFile(new URL('../skill/quickflo-agent-guide.md', import.meta.url)),
  );
  for (
    const value of [
      'uiMetadata.step',
      '"step"',
      'isTemplate: true',
      'core.sub-workflow',
      'steps library',
      'manifest.exports.steps',
    ]
  ) {
    assertStringIncludes(BUILDING_WORKFLOWS, value);
  }
  assertStringIncludes(AGENT_GUIDE, 'uiMetadata.step');
  assertStringIncludes(AGENT_GUIDE, 'list_workflow_steps');
});
