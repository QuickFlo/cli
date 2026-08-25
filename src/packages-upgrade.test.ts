import { assertEquals, assertStringIncludes } from '@std/assert';
import { outputPreview, printPreview } from './packages-upgrade.ts';

const ansiPattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);
const stripAnsi = (value: string): string => value.replace(ansiPattern, '');

const CURRENT_API_PREVIEW = {
  packageSummary: {
    slug: '@quickflo/example',
    name: 'Example',
    version: '1.1.0',
  },
  fromVersion: '1.0.0',
  toVersion: '1.1.0',
  diff: {
    resourceChanges: [
      { kind: 'workflow', name: 'example-workflow', change: 'replaced' },
    ],
    newPeerDeps: {
      connections: [],
      sharedEnvs: [],
      flatEnvs: [],
      dataStoreTables: [],
      extensionPoints: [],
    },
    sharedDefaultChanges: [],
    editedResourceWarnings: [],
    aliasReplay: { applicable: [], invalidated: [] },
    extensionPointBindingChanges: [],
  },
  resources: [],
  peerDepDecisions: [],
  sharedEnvKeys: [],
  currentBindings: {
    aliases: [],
    workflowAttachedEnvs: {},
    triggerEnvironments: {},
  },
} as const;

Deno.test('packages upgrade renders the current structured reinstall diff', () => {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    printPreview(
      CURRENT_API_PREVIEW as unknown as Parameters<typeof printPreview>[0],
    );
  } finally {
    console.error = originalError;
  }

  const output = stripAnsi(lines.join('\n'));
  assertStringIncludes(output, 'Resource changes: 1');
  assertStringIncludes(output, '[workflow] example-workflow');
});

Deno.test('packages upgrade JSON preview emits only the untouched API payload', () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '));
  try {
    outputPreview(
      CURRENT_API_PREVIEW as unknown as Parameters<typeof outputPreview>[0],
      { json: true, apply: false },
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assertEquals(stderr, []);
  assertEquals(JSON.parse(stdout.join('\n')), CURRENT_API_PREVIEW);
});
