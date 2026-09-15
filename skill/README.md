# QuickFlo agent skill

Teach any AI agent harness to drive QuickFlo. **One canonical source, thin per-harness adapters** — generated, never hand-maintained.

## Canonical content (the single source of truth)
- **`quickflo-agent-guide.md`** — the operating guide: command surface, auth/org rules, the write→validate→push loop, execution debugging, search-attribute filtering. Harness-neutral (no frontmatter, no harness-specific tokens).
- **`building-workflows.md`** — the deep workflow-authoring guide (definition format, LiquidJS, tool-workflow contract).
- **`building-dashboards.md`** — the deep dashboard-authoring guide (field refs, filtering, chart types, the verify→check→push loop, the silent-zero-rows traps).

Edit these. Everything else is generated.

## Install

The guides ship **embedded in the `quickflo` CLI**, so install needs no repo and no network:

```bash
quickflo skill install cursor     # ~/.cursor/skills/quickflo
quickflo skill install codex      # ~/.agents/skills/quickflo
quickflo skill install claude     # ~/.claude/skills/quickflo (also the default)
quickflo skill install shared     # ~/.agents/skills/quickflo (shared skill directory)
quickflo skill install agents     # operating guide → ./AGENTS.md
quickflo skill install mcp        # print the MCP host-config snippet

# No quickflo yet? One shot, no repo:
deno run -A jsr:@quickflo/cli skill install cursor
```

**Global is the default:** installs go in the user's home directory and apply across projects. The same commands work on Windows (`%USERPROFILE%` when `HOME` is unset). `--scope global` makes the default explicit; `--scope user` is an alias.

To install in a project, run from that project's directory:

```sh
quickflo skill install shared --scope project
```

Project scope uses the current working directory: `.agents/skills/quickflo` for `shared` or `codex`, `.cursor/skills/quickflo` for `cursor`, and `.claude/skills/quickflo` for `claude`. The `shared` target follows the [shared skill directory convention](https://agentskills.io/client-implementation/adding-skills-support#where-to-scan) for agents that scan `.agents/skills`.

Pass the complete skill directory as a final argument to override either scope, for example `quickflo skill install cursor ./my-skills/quickflo`. All skill targets write `SKILL.md` and both companion guides. The no-argument default stays at `~/.claude/skills/quickflo` for compatibility. `agents` still exports an `AGENTS.md` file; `agents` and `mcp` do not accept `--scope`.

From a repo checkout, `./install.sh [harness] [target] [--scope global|project]` re-embeds from the canonical `*.md` in this directory (`deno task bundle:guides`), then delegates to `quickflo skill install` — one adapter implementation, repo and repo-less. Project scope uses the directory from which you run the script.

## How "agnostic" works: two channels

- **Tools → MCP.** `quickflo mcp` is the cross-harness tool standard — the same server works in Claude Desktop/Code, Cursor, Codex, and any MCP host. It also serves this guide (server `instructions` + `quickflo://` resources), so MCP hosts get the how-to with no extra file. This is the most portable channel.
- **Knowledge → markdown.** The three canonical guides above. Per-harness differences are only invocation metadata, filename, and location, which `src/skill-install.ts` applies:

| Harness | Mechanism | Loading |
| --- | --- | --- |
| Cursor, Codex, shared | `SKILL.md` (Agent Skills standard) | lazy (description-gated) |
| Claude Code | `SKILL.md` plus Claude Code invocation metadata | lazy (description-gated) |
| agents.md agents | `AGENTS.md` | eager (always-on) |
| Any MCP host (Cursor, …) | `quickflo mcp` server | tools + on-demand resources |

Because `AGENTS.md` is eager, the `agents` adapter ships only the operating guide and defers the heavy authoring guide to on-demand (the `building-workflows.md` file / `quickflo://building-workflows` MCP resource).
