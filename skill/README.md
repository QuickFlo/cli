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
quickflo skill install                               # Claude skill → ~/.claude/skills/quickflo
quickflo skill install agents ~/.codex/AGENTS.md     # Codex / agents.md
quickflo skill install mcp                           # print the MCP host-config snippet

# No quickflo yet? One shot, no repo:
deno run -A jsr:@quickflo/cli skill install
```

From a repo checkout, `./install.sh [harness] [target]` re-embeds from the canonical `*.md` in this directory (`deno task bundle:guides`), then delegates to `quickflo skill install` — one adapter implementation, repo and repo-less.

## How "agnostic" works: two channels

- **Tools → MCP.** `quickflo mcp` is the cross-harness tool standard — the same server works in Claude Desktop/Code, Cursor, Codex, and any MCP host. It also serves this guide (server `instructions` + `quickflo://` resources), so MCP hosts get the how-to with no extra file. This is the most portable channel.
- **Knowledge → markdown.** The two canonical docs above. Per-harness differences are only frontmatter / filename / location, which `install.sh` applies:

| Harness | Mechanism | Loading |
| --- | --- | --- |
| Claude Code/Desktop/claude.ai | `SKILL.md` (Anthropic Skills) | lazy (description-gated) |
| Codex + agents.md agents | `AGENTS.md` | eager (always-on) |
| Any MCP host (Cursor, …) | `quickflo mcp` server | tools + on-demand resources |

Because `AGENTS.md` is eager, the `agents` adapter ships only the operating guide and defers the heavy authoring guide to on-demand (the `building-workflows.md` file / `quickflo://building-workflows` MCP resource).
