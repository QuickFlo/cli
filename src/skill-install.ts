/**
 * `quickflo skill install [harness] [target]` — materialize the QuickFlo agent
 * skill from the guides EMBEDDED in this CLI (`src/skill-guides.ts`), so it
 * installs with no repo checkout and no network. The repo's `skill/install.sh`
 * delegates here, so there is exactly one adapter implementation.
 *
 * Diagnostics → stderr; only the `mcp` config snippet (the payload) → stdout.
 */

import { AGENT_GUIDE, BUILDING_DASHBOARDS, BUILDING_WORKFLOWS } from './skill-guides.ts';

const NAME = 'quickflo';
const DESC = 'Drive the QuickFlo platform from the terminal with the `quickflo` command: ' +
  'inspect/run/validate workflows, tail and download executions, browse the step ' +
  'catalog, build and query dashboards and their data sources (BI/analytics), and ' +
  'manage triggers, connections, environments, data-stores, dashboards, and ' +
  'packages across orgs. Use whenever you need a local agent harness to work ' +
  'against a live QuickFlo org.';

const MCP_SNIPPET = `Add the QuickFlo MCP server to your host config (Claude Desktop/Code, Cursor,
Codex ~/.codex/config.toml [mcp_servers], …). Run \`quickflo auth login\` first.

{
  "mcpServers": {
    "quickflo": { "command": "quickflo", "args": ["mcp"], "env": { "QF_ORG": "<org-suid>" } }
  }
}

The server exposes the workflow tools AND serves the guides (server instructions
+ quickflo:// resources), so MCP hosts need no per-harness doc file.`;

function home(): string {
  return Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '.';
}

export interface SkillInstallOptions {
  /** claude | agents | mcp. Defaults to claude. */
  harness?: string;
  /** Target dir (claude) or file (agents). Defaults per harness. */
  target?: string;
}

export async function runSkillInstall(opts: SkillInstallOptions): Promise<void> {
  const harness = (opts.harness || 'claude').toLowerCase();
  switch (harness) {
    case 'claude': {
      const dir = opts.target || `${home()}/.claude/skills/quickflo`;
      await Deno.mkdir(dir, { recursive: true });
      const skillMd = `---
name: ${NAME}
description: ${DESC}
user-invocable: true
argument-hint: what you want to do (e.g. "list failed runs today")
---

${AGENT_GUIDE}

## Your task

$ARGUMENTS
`;
      await Deno.writeTextFile(`${dir}/SKILL.md`, skillMd);
      await Deno.writeTextFile(`${dir}/building-workflows.md`, BUILDING_WORKFLOWS);
      await Deno.writeTextFile(`${dir}/building-dashboards.md`, BUILDING_DASHBOARDS);
      console.error(
        `Installed Claude skill → ${dir}/{SKILL.md,building-workflows.md,building-dashboards.md}`,
      );
      return;
    }
    case 'agents': {
      const out = opts.target || './AGENTS.md';
      // AGENTS.md is eager (always-on); ship the operating guide and defer the
      // heavy authoring guide to on-demand.
      const content = '> QuickFlo operating guide (drive the platform via the `quickflo` CLI). ' +
        'Deep authoring guides: the `quickflo://building-workflows` and ' +
        '`quickflo://building-dashboards` MCP resources, or building-workflows.md / ' +
        'building-dashboards.md in https://github.com/QuickFlo/cli.\n\n' +
        AGENT_GUIDE;
      await Deno.writeTextFile(out, content);
      console.error(
        `Installed AGENTS.md → ${out}  (Codex: ~/.codex/AGENTS.md for global, or place at repo root)`,
      );
      return;
    }
    case 'mcp': {
      console.log(MCP_SNIPPET);
      return;
    }
    default:
      throw new Error(`Unknown harness "${harness}". Use: claude | agents | mcp.`);
  }
}
