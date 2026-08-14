import { assert, assertEquals } from '@std/assert';
import { buildWorkflowPayload, type WorkflowDefinition } from './workflows-save.ts';
import {
  formatWorkflowForPush,
  layoutWorkflowSteps,
  workflowDefinitionToGraph,
} from './workflow-layout.ts';

Deno.test('workflowDefinitionToGraph mirrors branch and convergence edges', () => {
  const graph = workflowDefinitionToGraph([
    { stepId: 'start', stepType: 'core.log' },
    {
      stepId: 'route',
      stepType: 'core.if',
      input: {
        then: [{ stepId: 'yes', stepType: 'core.log' }],
        else: [{ stepId: 'no', stepType: 'core.log' }],
      },
    },
    { stepId: 'finish', stepType: 'core.return' },
  ]);

  assertEquals(graph.nodes.map((node) => node.id), ['start', 'route', 'yes', 'no', 'finish']);
  assertEquals(
    graph.edges.map((edge) => [edge.source, edge.sourceHandle, edge.target]),
    [
      ['start', 'output', 'route'],
      ['route', 'then', 'yes'],
      ['yes', 'output', 'finish'],
      ['route', 'else', 'no'],
      ['no', 'output', 'finish'],
    ],
  );
});

Deno.test('layoutWorkflowSteps uses the builder compact-column layout', async () => {
  const steps = Array.from({ length: 7 }, (_, index) => ({
    stepId: String.fromCharCode(97 + index),
    stepType: index === 6 ? 'core.return' : 'core.log',
  }));

  const positions = await layoutWorkflowSteps(steps);

  assertEquals(Object.keys(positions).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assertEquals(positions['b']?.x, positions['c']?.x);
  assertEquals(positions['c']?.x, positions['d']?.x);
  assertEquals(positions['d']?.x, positions['e']?.x);
  assert((positions['c']?.y ?? 0) > (positions['b']?.y ?? 0));
  assert((positions['f']?.x ?? 0) > (positions['e']?.x ?? 0));
});

Deno.test('layoutWorkflowSteps positions nested control-flow steps', async () => {
  const positions = await layoutWorkflowSteps([
    {
      stepId: 'each',
      stepType: 'core.for-each',
      input: {
        steps: [
          {
            stepId: 'switch',
            stepType: 'core.switch',
            input: {
              cases: [{ caseId: 'one', steps: [{ stepId: 'case-step', stepType: 'core.log' }] }],
              default: [{ stepId: 'default-step', stepType: 'core.log' }],
            },
          },
        ],
      },
    },
    { stepId: 'done', stepType: 'core.return' },
  ]);

  assertEquals(Object.keys(positions).sort(), [
    'case-step',
    'default-step',
    'done',
    'each',
    'switch',
  ]);
  for (const position of Object.values(positions)) {
    assert(Number.isFinite(position.x));
    assert(Number.isFinite(position.y));
  }
});

Deno.test('formatWorkflowForPush fills missing positions and preserves manual metadata', async () => {
  const definition: WorkflowDefinition = {
    name: 'formatted',
    steps: [
      { stepId: 'manual', stepType: 'core.log' },
      { stepId: 'generated', stepType: 'core.return' },
    ],
    uiMetadata: {
      viewport: { zoom: 1.25 },
      nodePositions: {
        manual: { x: 900, y: 700 },
        'trigger:existing': { x: 10, y: 20 },
      },
    },
  };

  const formatted = await formatWorkflowForPush(definition);
  const metadata = formatted['uiMetadata'] as Record<string, unknown>;
  const positions = metadata['nodePositions'] as Record<string, { x: number; y: number }>;

  assertEquals(metadata['viewport'], { zoom: 1.25 });
  assertEquals(positions['manual'], { x: 900, y: 700 });
  assertEquals(positions['trigger:existing'], { x: 10, y: 20 });
  assert(Number.isFinite(positions['generated']?.x));
  assert(Number.isFinite(positions['generated']?.y));
  assertEquals(
    (definition['uiMetadata'] as Record<string, unknown>)['nodePositions'],
    {
      manual: { x: 900, y: 700 },
      'trigger:existing': { x: 10, y: 20 },
    },
  );

  const payload = buildWorkflowPayload(formatted);
  assertEquals(payload['uiMetadata'], metadata);
});
