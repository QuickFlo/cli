import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { AGENT_GUIDE, BUILDING_DASHBOARDS, BUILDING_WORKFLOWS } from './skill-guides.ts';
import { runSkillInstall, type SkillInstallOptions } from './skill-install.ts';

const PROJECT_DIRECTORY = '/work/project with spaces/nested';

async function captureInstall(
  options: SkillInstallOptions,
  environment: Record<string, string> = { HOME: '/home/example' },
  expectedError?: string,
) {
  const original = {
    mkdir: Deno.mkdir,
    writeTextFile: Deno.writeTextFile,
    getEnv: Deno.env.get,
    cwd: Deno.cwd,
    log: console.log,
    error: console.error,
  };
  const directories: string[] = [];
  const files = new Map<string, string>();
  const stdout: string[] = [];
  const stderr: string[] = [];

  Deno.mkdir = (path, options) => {
    assertEquals(options?.recursive, true);
    directories.push(String(path));
    return Promise.resolve();
  };
  Deno.writeTextFile = (path, content) => {
    assert(typeof content === 'string');
    files.set(String(path), content);
    return Promise.resolve();
  };
  Deno.env.get = (name) => environment[name];
  Deno.cwd = () => PROJECT_DIRECTORY;
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));

  try {
    if (expectedError) {
      await assertRejects(() => runSkillInstall(options), Error, expectedError);
    } else {
      await runSkillInstall(options);
    }
    return { directories, files, stdout, stderr };
  } finally {
    Deno.mkdir = original.mkdir;
    Deno.writeTextFile = original.writeTextFile;
    Deno.env.get = original.getEnv;
    Deno.cwd = original.cwd;
    console.log = original.log;
    console.error = original.error;
  }
}

Deno.test('Cursor, Codex, and shared install complete standard skills in their discovered directories', async () => {
  for (
    const [harness, root] of [['cursor', '.cursor'], ['codex', '.agents'], ['shared', '.agents']]
  ) {
    const result = await captureInstall({ harness });
    const directory = join('/home/example', root, 'skills', 'quickflo');
    assertEquals(result.directories, [directory]);
    assertEquals(result.files.size, 3);
    assertEquals(result.files.get(`${directory}/building-workflows.md`), BUILDING_WORKFLOWS);
    assertEquals(result.files.get(`${directory}/building-dashboards.md`), BUILDING_DASHBOARDS);
    const skill = result.files.get(`${directory}/SKILL.md`) ?? '';
    assertStringIncludes(skill, '---\nname: quickflo\ndescription: ');
    assertStringIncludes(skill, AGENT_GUIDE);
    assert(!skill.includes('$ARGUMENTS'));
    assert(!skill.includes('argument-hint:'));
    assert(!skill.includes('user-invocable:'));
    assertEquals(result.stdout, []);
    assertStringIncludes(result.stderr[0], 'Installed QuickFlo agent skill');
    assert(!result.stderr[0].includes('Claude'));
  }
});

Deno.test('skill install honors USERPROFILE fallback and home precedence', async () => {
  for (const [harness, root] of [['CURSOR', '.cursor'], ['SHARED', '.agents']]) {
    const windows = await captureInstall({ harness }, {
      USERPROFILE: 'C:\\Users\\A Person',
    });
    assertEquals(windows.directories, [join('C:\\Users\\A Person', root, 'skills', 'quickflo')]);
  }
  const home = await captureInstall({ harness: 'codex' }, {
    HOME: '/custom/home',
    USERPROFILE: 'C:\\Users\\A Person',
  });
  assertEquals(home.directories, [join('/custom/home', '.agents', 'skills', 'quickflo')]);
});

Deno.test('global scope is the default and user is an alias for every skill target', async () => {
  for (const harness of [undefined, 'claude', 'cursor', 'codex', 'shared']) {
    const implicit = await captureInstall({ harness });
    assertEquals(await captureInstall({ harness, scope: 'global' }), implicit);
    assertEquals(await captureInstall({ harness, scope: 'user' }), implicit);
  }
});

Deno.test('project scope writes all guides under cwd for every skill target', async () => {
  for (
    const [harness, root] of [
      [undefined, '.claude'],
      ['claude', '.claude'],
      ['cursor', '.cursor'],
      ['codex', '.agents'],
      ['shared', '.agents'],
    ] as const
  ) {
    const result = await captureInstall({ harness, scope: 'project' }, {});
    const directory = join(PROJECT_DIRECTORY, root, 'skills', 'quickflo');
    assertEquals(result.directories, [directory]);
    assertEquals(result.files.size, 3);
    assertEquals(result.files.get(`${directory}/building-workflows.md`), BUILDING_WORKFLOWS);
    assertEquals(result.files.get(`${directory}/building-dashboards.md`), BUILDING_DASHBOARDS);
    const skill = result.files.get(`${directory}/SKILL.md`) ?? '';
    assertStringIncludes(skill, AGENT_GUIDE);
    assertEquals(skill.includes('user-invocable: true'), root === '.claude');
    assertStringIncludes(result.stderr[0], directory);
    assertEquals(result.stdout, []);
  }
});

Deno.test('explicit skill paths override every scope without appending another directory', async () => {
  for (const harness of ['claude', 'cursor', 'codex', 'shared']) {
    for (const scope of [undefined, 'global', 'user', 'project'] as const) {
      const custom = await captureInstall({ harness, scope, target: './my skills/quickflo' }, {});
      assertEquals(custom.directories, ['./my skills/quickflo']);
      assertEquals(custom.files.size, 3);
      assert(custom.files.has('./my skills/quickflo/SKILL.md'));
    }
  }
});

Deno.test('default and explicit Claude installs keep the existing destination and invocation wrapper', async () => {
  const implicit = await captureInstall({});
  const explicit = await captureInstall({ harness: 'claude' });
  assertEquals(implicit, explicit);
  const directory = join('/home/example', '.claude', 'skills', 'quickflo');
  assertEquals(implicit.directories, [directory]);
  const skill = implicit.files.get(`${directory}/SKILL.md`) ?? '';
  assertStringIncludes(skill, 'user-invocable: true\nargument-hint: ');
  assert(skill.endsWith('\n## Your task\n\n$ARGUMENTS\n'));
  assertStringIncludes(implicit.stderr[0], 'Installed QuickFlo agent skill');
});

Deno.test('AGENTS.md and MCP exports retain their distinct output contracts', async () => {
  const defaultAgents = await captureInstall({ harness: 'agents' });
  assertEquals([...defaultAgents.files.keys()], ['./AGENTS.md']);
  const agents = await captureInstall({ harness: 'agents', target: './project/AGENTS.md' });
  assertEquals(agents.directories, []);
  assertEquals(agents.files.size, 1);
  assertStringIncludes(agents.files.get('./project/AGENTS.md') ?? '', AGENT_GUIDE);
  assertEquals(agents.stdout, []);
  const mcp = await captureInstall({ harness: 'mcp' });
  assertEquals(mcp.files.size, 0);
  assertEquals(mcp.directories, []);
  assertEquals(mcp.stderr, []);
  assertStringIncludes(mcp.stdout[0], '"command": "quickflo", "args": ["mcp"]');
});

Deno.test('legacy exports reject explicit scopes before writing or printing output', async () => {
  for (const harness of ['agents', 'mcp']) {
    for (const scope of ['global', 'project', 'user'] as const) {
      const result = await captureInstall(
        { harness, scope },
        {},
        '--scope is only supported for skill targets',
      );
      assertEquals(result.directories, []);
      assertEquals(result.files.size, 0);
      assertEquals(result.stdout, []);
      assertEquals(result.stderr, []);
    }
  }
});

Deno.test('invalid scope is rejected before writing even with a custom target', async () => {
  const result = await captureInstall(
    {
      harness: 'shared',
      scope: 'local' as SkillInstallOptions['scope'],
      target: './my skills/quickflo',
    },
    {},
    'Unknown scope "local"',
  );
  assertEquals(result.directories, []);
  assertEquals(result.files.size, 0);
  assertEquals(result.stdout, []);
  assertEquals(result.stderr, []);
});

Deno.test('unknown skill target reports all supported harnesses', async () => {
  await assertRejects(
    () => captureInstall({ harness: 'unknown' }),
    Error,
    'Use: claude | cursor | codex | shared | agents | mcp.',
  );
});
