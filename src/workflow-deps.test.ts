import { assertEquals, assertThrows } from '@std/assert';
import {
  DuplicateKeyError,
  extractSubWorkflowRefs,
  type PushFileNode,
  topoSortFiles,
} from './workflow-deps.ts';

function fileNode(
  filename: string,
  def: { id?: string; name?: string; steps?: unknown[] },
): PushFileNode {
  return { filename, def, refs: extractSubWorkflowRefs(def) };
}

Deno.test('extractor: top-level sub-workflow by name', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'call-b',
        stepType: 'core.sub-workflow',
        input: { workflowTemplateName: 'b' },
      },
    ],
  });
  assertEquals([...refs.names], ['b']);
  assertEquals([...refs.ids], []);
  assertEquals(refs.dynamic, []);
  assertEquals(refs.external, []);
});

Deno.test('extractor: top-level sub-workflow by id', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'call-b',
        stepType: 'core.sub-workflow',
        input: { workflowTemplateId: 'uuid-b' },
      },
    ],
  });
  assertEquals([...refs.ids], ['uuid-b']);
});

Deno.test('extractor: sub-workflow nested in for-each', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'loop',
        stepType: 'core.for-each',
        input: {
          items: '{{ $vars.list }}',
          steps: [
            {
              stepId: 'call-b',
              stepType: 'core.sub-workflow',
              input: { workflowTemplateName: 'b' },
            },
          ],
        },
      },
    ],
  });
  assertEquals([...refs.names], ['b']);
});

Deno.test('extractor: sub-workflows in if.then and if.else', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'branch',
        stepType: 'core.if',
        input: {
          condition: true,
          then: [
            {
              stepId: 'call-b',
              stepType: 'core.sub-workflow',
              input: { workflowTemplateName: 'b' },
            },
          ],
          else: [
            {
              stepId: 'call-c',
              stepType: 'core.sub-workflow',
              input: { workflowTemplateName: 'c' },
            },
          ],
        },
      },
    ],
  });
  assertEquals([...refs.names].sort(), ['b', 'c']);
});

Deno.test('extractor: sub-workflows in switch cases and default', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'route',
        stepType: 'core.switch',
        input: {
          cases: [
            {
              caseId: 'caseA',
              when: true,
              steps: [
                {
                  stepId: 'call-a',
                  stepType: 'core.sub-workflow',
                  input: { workflowTemplateName: 'a' },
                },
              ],
            },
          ],
          default: [
            {
              stepId: 'call-d',
              stepType: 'core.sub-workflow',
              input: { workflowTemplateName: 'd' },
            },
          ],
        },
      },
    ],
  });
  assertEquals([...refs.names].sort(), ['a', 'd']);
});

Deno.test('extractor: dynamic detection ignores whitespace variants', () => {
  const variants = [
    '{{foo}}',
    '{{ foo }}',
    '{{foo }}',
    '{{ foo}}',
    '{{-foo-}}',
    '{{- foo -}}',
    '{% if x %}b{% endif %}',
    '{%- if x -%}b{%- endif -%}',
  ];
  for (const v of variants) {
    const refs = extractSubWorkflowRefs({
      steps: [
        {
          stepId: 'dyn',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: v },
        },
      ],
    });
    assertEquals([...refs.names], [], `variant "${v}" leaked into names`);
    assertEquals(refs.dynamic.length, 1, `variant "${v}" not flagged dynamic`);
  }
});

Deno.test('extractor: dynamic refs go to dynamic, not graph', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'dynamic-call',
        stepType: 'core.sub-workflow',
        input: { workflowTemplateName: '{{ initial.target }}' },
      },
    ],
  });
  assertEquals([...refs.names], []);
  assertEquals(refs.dynamic.length, 1);
  assertEquals(refs.dynamic[0].value, '{{ initial.target }}');
  assertEquals(refs.dynamic[0].kind, 'name');
});

Deno.test('extractor: namespaced refs go to external, not graph', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'common-call',
        stepType: 'core.sub-workflow',
        input: { workflowTemplateName: '@common/send-notification' },
      },
      {
        stepId: 'other-org',
        stepType: 'core.sub-workflow',
        input: { workflowTemplateName: '@acme123/custom' },
      },
    ],
  });
  assertEquals([...refs.names], []);
  assertEquals(refs.external.sort(), ['@acme123/custom', '@common/send-notification']);
});

Deno.test('extractor: ai.agent tools with templateId become id refs', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'agent',
        stepType: 'ai.agent',
        input: {
          goal: 'do the thing',
          tools: [
            { templateId: 'uuid-tool-1', name: 'lookup' },
            { templateId: 'uuid-tool-2', name: 'act' },
          ],
        },
      },
    ],
  });
  assertEquals([...refs.ids].sort(), ['uuid-tool-1', 'uuid-tool-2']);
  assertEquals([...refs.names], []);
  assertEquals(refs.dynamic, []);
});

Deno.test('extractor: ai.agent tool with dynamic templateId is classified as dynamic', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'agent',
        stepType: 'ai.agent',
        input: {
          goal: 'dynamic',
          tools: [
            { templateId: '{{ initial.toolId }}' },
            { templateId: 'uuid-static' },
          ],
        },
      },
    ],
  });
  assertEquals([...refs.ids], ['uuid-static']);
  assertEquals(refs.dynamic.length, 1);
  assertEquals(refs.dynamic[0].kind, 'id');
  assertEquals(refs.dynamic[0].value, '{{ initial.toolId }}');
});

Deno.test('extractor: ai.agent nested in for-each surfaces tool refs', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'loop',
        stepType: 'core.for-each',
        input: {
          items: '{{ $vars.list }}',
          steps: [
            {
              stepId: 'agent',
              stepType: 'ai.agent',
              input: {
                goal: 'per item',
                tools: [{ templateId: 'uuid-looped-tool' }],
              },
            },
          ],
        },
      },
    ],
  });
  assertEquals([...refs.ids], ['uuid-looped-tool']);
});

Deno.test('extractor: ai.agent with no tools array does not throw', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'agent',
        stepType: 'ai.agent',
        input: { goal: 'no tools' },
      },
    ],
  });
  assertEquals([...refs.ids], []);
  assertEquals([...refs.names], []);
});

Deno.test('topo: ai.agent tool ref causes caller to land after tool workflow', () => {
  const nodes = [
    fileNode('caller.json', {
      name: 'caller',
      steps: [
        {
          stepId: 'agent',
          stepType: 'ai.agent',
          input: {
            goal: 'delegate',
            tools: [{ templateId: 'uuid-tool' }],
          },
        },
      ],
    }),
    fileNode('tool.json', { id: 'uuid-tool', name: 'tool', steps: [] }),
  ];
  const { order } = topoSortFiles(nodes);
  assertEquals(
    order.map((n) => n.filename),
    ['tool.json', 'caller.json'],
  );
});

Deno.test('extractor: deeply nested (for-each > if > sub-workflow)', () => {
  const refs = extractSubWorkflowRefs({
    steps: [
      {
        stepId: 'loop',
        stepType: 'core.for-each',
        input: {
          items: '{{ $vars.list }}',
          steps: [
            {
              stepId: 'branch',
              stepType: 'core.if',
              input: {
                condition: true,
                then: [
                  {
                    stepId: 'call-deep',
                    stepType: 'core.sub-workflow',
                    input: { workflowTemplateName: 'deep' },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  });
  assertEquals([...refs.names], ['deep']);
});

Deno.test('topo: 3-level chain C <- B <- A uploads as C, B, A regardless of filename order', () => {
  const nodes = [
    fileNode('a.json', {
      name: 'a',
      steps: [
        {
          stepId: 'to-b',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'b' },
        },
      ],
    }),
    fileNode('b.json', {
      name: 'b',
      steps: [
        {
          stepId: 'to-c',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'c' },
        },
      ],
    }),
    fileNode('c.json', { name: 'c', steps: [] }),
  ];
  const { order } = topoSortFiles(nodes);
  assertEquals(order.map((n) => n.filename), ['c.json', 'b.json', 'a.json']);
});

Deno.test('topo: cycle is reported as warning, not error — runtime guard handles recursion', () => {
  const nodes = [
    fileNode('a.json', {
      name: 'a',
      steps: [
        {
          stepId: 'to-b',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'b' },
        },
      ],
    }),
    fileNode('b.json', {
      name: 'b',
      steps: [
        {
          stepId: 'to-a',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'a' },
        },
      ],
    }),
  ];
  const { order, cycles } = topoSortFiles(nodes);
  // Both files are still in the output (engine depth guard will catch
  // infinite recursion at runtime; static push block would be too aggressive).
  assertEquals(order.length, 2);
  const names = order.map((n) => n.filename).sort();
  assertEquals(names, ['a.json', 'b.json']);
  assertEquals(cycles.length, 1);
  const members = new Set(cycles[0]);
  assertEquals(members.has('a.json'), true);
  assertEquals(members.has('b.json'), true);
});

Deno.test('topo: cycle members alphabetized, non-cycle nodes come first', () => {
  const nodes = [
    fileNode('a.json', {
      name: 'a',
      steps: [
        {
          stepId: 'to-b',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'b' },
        },
      ],
    }),
    fileNode('b.json', {
      name: 'b',
      steps: [
        {
          stepId: 'to-a',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'a' },
        },
      ],
    }),
    fileNode('independent.json', { name: 'independent', steps: [] }),
  ];
  const { order, cycles } = topoSortFiles(nodes);
  assertEquals(order.length, 3);
  // Independent node processed first; cycle members appended alphabetically.
  assertEquals(
    order.map((n) => n.filename),
    ['independent.json', 'a.json', 'b.json'],
  );
  assertEquals(cycles.length, 1);
});

Deno.test('topo: duplicate name throws', () => {
  const nodes = [
    fileNode('a1.json', { name: 'shared', steps: [] }),
    fileNode('a2.json', { name: 'shared', steps: [] }),
  ];
  assertThrows(() => topoSortFiles(nodes), DuplicateKeyError);
});

Deno.test('topo: duplicate id throws', () => {
  const nodes = [
    fileNode('a.json', { id: 'uuid-1', name: 'a', steps: [] }),
    fileNode('b.json', { id: 'uuid-1', name: 'b', steps: [] }),
  ];
  assertThrows(() => topoSortFiles(nodes), DuplicateKeyError);
});

Deno.test('topo: external and dynamic refs do not block or add edges', () => {
  const nodes = [
    fileNode('a.json', {
      name: 'a',
      steps: [
        {
          stepId: 'external',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: '@common/notify' },
        },
        {
          stepId: 'dynamic',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: '{{ initial.target }}' },
        },
      ],
    }),
    fileNode('b.json', { name: 'b', steps: [] }),
  ];
  const { order, unresolved } = topoSortFiles(nodes);
  assertEquals(order.map((n) => n.filename), ['a.json', 'b.json']);
  assertEquals(unresolved, []);
});

Deno.test('topo: unresolved ref does not block, is reported', () => {
  const nodes = [
    fileNode('a.json', {
      name: 'a',
      steps: [
        {
          stepId: 'missing',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'not-in-set' },
        },
      ],
    }),
  ];
  const { order, unresolved } = topoSortFiles(nodes);
  assertEquals(order.map((n) => n.filename), ['a.json']);
  assertEquals(unresolved.length, 1);
  assertEquals(unresolved[0].value, 'not-in-set');
  assertEquals(unresolved[0].kind, 'name');
});

Deno.test('topo: id refs across push set resolve', () => {
  const nodes = [
    fileNode('caller.json', {
      name: 'caller',
      steps: [
        {
          stepId: 'by-id',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateId: 'uuid-callee' },
        },
      ],
    }),
    fileNode('callee.json', {
      id: 'uuid-callee',
      name: 'callee',
      steps: [],
    }),
  ];
  const { order } = topoSortFiles(nodes);
  assertEquals(order.map((n) => n.filename), ['callee.json', 'caller.json']);
});

Deno.test('topo: mixed graph — valid topo order with alpha tie-break', () => {
  const nodes = [
    fileNode('zeta.json', { name: 'zeta', steps: [] }),
    fileNode('alpha.json', { name: 'alpha', steps: [] }),
    fileNode('mu.json', {
      name: 'mu',
      steps: [
        {
          stepId: 'to-alpha',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'alpha' },
        },
      ],
    }),
  ];
  const { order } = topoSortFiles(nodes);
  const names = order.map((n) => n.filename);
  // Kahn's + alpha tie-break processes newly-unblocked nodes immediately,
  // so mu lands right after alpha rather than at the end.
  assertEquals(names, ['alpha.json', 'mu.json', 'zeta.json']);
  // Critical invariant: alpha precedes mu.
  assertEquals(
    names.indexOf('alpha.json') < names.indexOf('mu.json'),
    true,
  );
});

Deno.test('topo: single file, no deps — works', () => {
  const nodes = [fileNode('solo.json', { name: 'solo', steps: [] })];
  const { order, unresolved } = topoSortFiles(nodes);
  assertEquals(order.map((n) => n.filename), ['solo.json']);
  assertEquals(unresolved, []);
});

Deno.test('topo: self-reference is ignored', () => {
  const nodes = [
    fileNode('self.json', {
      name: 'self',
      steps: [
        {
          stepId: 'loop-to-self',
          stepType: 'core.sub-workflow',
          input: { workflowTemplateName: 'self' },
        },
      ],
    }),
  ];
  const { order } = topoSortFiles(nodes);
  assertEquals(order.map((n) => n.filename), ['self.json']);
});
