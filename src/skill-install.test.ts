import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { AGENT_GUIDE, BUILDING_DASHBOARDS, BUILDING_WORKFLOWS } from './skill-guides.ts';
import { runSkillInstall, type SkillInstallOptions } from './skill-install.ts';

async function captureInstall(
  options: SkillInstallOptions,
  environment: Record<string, string> = { HOME: '/home/example' },
) {
  const original = {
    mkdir: Deno.mkdir,
    writeTextFile: Deno.writeTextFile,
    getEnv: Deno.env.get,
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
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));

  try {
    await runSkillInstall(options);
    return { directories, files, stdout, stderr };
  } finally {
    Deno.mkdir = original.mkdir;
    Deno.writeTextFile = original.writeTextFile;
    Deno.env.get = original.getEnv;
    console.log = original.log;
    console.error = original.error;
  }
}

Deno.test('Cursor and Codex install complete standard skills in their discovered directories', async () => {
  for (const [harness, root] of [['cursor', '.cursor'], ['codex', '.agents']]) {
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

Deno.test('skill install honors USERPROFILE fallback, home precedence, and explicit paths', async () => {
  const windows = await captureInstall({ harness: 'CURSOR' }, {
    USERPROFILE: 'C:\\Users\\A Person',
  });
  assertEquals(windows.directories, [join('C:\\Users\\A Person', '.cursor', 'skills', 'quickflo')]);
  const home = await captureInstall({ harness: 'codex' }, {
    HOME: '/custom/home',
    USERPROFILE: 'C:\\Users\\A Person',
  });
  assertEquals(home.directories, [join('/custom/home', '.agents', 'skills', 'quickflo')]);
  for (const harness of ['claude', 'cursor', 'codex']) {
    const custom = await captureInstall({ harness, target: './my skills/quickflo' });
    assertEquals(custom.directories, ['./my skills/quickflo']);
    assert(custom.files.has('./my skills/quickflo/SKILL.md'));
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

Deno.test('unknown skill target reports all supported harnesses', async () => {
  await assertRejects(
    () => captureInstall({ harness: 'unknown' }),
    Error,
    'Use: claude | cursor | codex | agents | mcp.',
  );
});
