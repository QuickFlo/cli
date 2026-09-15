#!/usr/bin/env bash
#
# Repo convenience installer. Refreshes the embedded guides from skill/*.md,
# then installs via the CLI's `skill install` — ONE adapter implementation,
# shared with the repo-less path (`quickflo skill install` /
# `deno run -A jsr:@quickflo/cli skill install`).
#
#   ./install.sh                QuickFlo agent skill → ~/.claude/skills/quickflo (default)
#   ./install.sh cursor [dir]   QuickFlo agent skill → ~/.cursor/skills/quickflo
#   ./install.sh codex [dir]    QuickFlo agent skill → ~/.agents/skills/quickflo
#   ./install.sh claude [dir]   QuickFlo agent skill → ~/.claude/skills/quickflo
#   ./install.sh agents [file]   AGENTS.md (Codex / agents.md)   → file (default ./AGENTS.md)
#   ./install.sh mcp             print the MCP host-config snippet
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# Re-embed from the canonical markdown so a local edit is reflected.
deno run --allow-read --allow-write "$HERE/bundle-guides.ts"

exec deno run --allow-read --allow-write --allow-env "$HERE/../mod.ts" skill install "$@"
