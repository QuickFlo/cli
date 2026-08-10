# QuickFlo CLI

Command-line interface for [QuickFlo](https://quickflo.app) — push and pull workflows, install and
publish packages, and manage your QuickFlo organization from your terminal.

## Install

### Pre-built binary (recommended, no dependencies)

```bash
curl -fsSL https://cdn.quickflo.app/packages/cli/install.sh | sh
```

Detects your OS + arch, downloads the matching binary, drops it in `~/.local/bin`. Supports macOS
(Intel + Apple Silicon), Linux (x86_64 + arm64), and Windows (x86_64).

Pin a version: `… | sh -s v1.0.2`. Install elsewhere: `… | INSTALL_DIR=/usr/local/bin sh`.

### Via JSR (requires [Deno](https://deno.com) 2+)

```bash
deno install --global --force --name quickflo \
  --allow-net --allow-read --allow-env --allow-write \
  jsr:@quickflo/cli
```

Make sure `~/.deno/bin` is on your `PATH`. To upgrade later, re-run the same command — `--force`
overwrites with the latest published version.

### Quick start

```bash
quickflo auth login       # paste a token from Settings → Access Tokens
quickflo workflows list   # use it
```

## Auth

The CLI authenticates with **Personal Access Tokens**, organized into named
**profiles** so you can keep tokens for multiple orgs / deployments and switch
between them with one command. Mint a token in the QuickFlo web UI under
**Settings → Access Tokens**.

### Quick start

```bash
quickflo auth login          # paste token (hidden input), saves as a profile
quickflo workflows list      # uses the active profile
```

`auth login` probes the token via `/auth/me`, then saves it under a profile
named after the org's SUID by default. The new profile becomes active.

### Working with multiple profiles

```bash
quickflo auth login                  # → saves profile "acme" (auto-named)
quickflo auth login --as personal    # → saves profile "personal" (explicit)

quickflo auth list                   # show all profiles, * marks active
#   NAME      ORG            SUID
#   acme      Acme Corp      acme
# * personal  My Personal    myorg

quickflo auth use acme               # switch active profile
quickflo workflows list              # → now hits acme's API + org

quickflo auth logout acme            # delete a specific profile
quickflo auth logout                 # delete the currently active one
```

### Per-command overrides

```bash
QF_PROFILE=acme quickflo workflows list      # one-shot profile switch
QF_TOKEN=qfp_… quickflo workflows list       # bypass profiles entirely (CI use)
```

### Resolution order

1. **`QF_TOKEN`** env var — ad-hoc one-shot, pairs with `QF_API_URL`. Bypasses profiles.
2. **`QF_PROFILE`** env var — session-scoped override of the active profile.
3. **`currentProfile`** in `~/.config/quickflo/credentials.json` — long-lived selection.
4. Fail with a hint listing available profiles or pointing to `quickflo auth login`.

### Where it's stored

Profiles live at `$XDG_CONFIG_HOME/quickflo/credentials.json` (mode `0600`).
Each profile bundles its api URL + token + cached org metadata, so switching
profiles switches everything in one move.

```json
{
  "version": 2,
  "currentProfile": "acme",
  "profiles": {
    "acme": {
      "apiUrl": "https://go.quickflo.app/api",
      "token": "qfp_…",
      "orgSuid": "acme",
      "orgName": "Acme Corp",
      "savedAt": "2026-05-11T…"
    }
  }
}
```

### Targeting self-hosted deployments

Pass `--api-url` at login time (it gets bundled into the profile, no need to
re-pass it on every command):

```bash
quickflo auth login --api-url https://my-quickflo.example.com/api --as self-hosted
quickflo auth use self-hosted
quickflo workflows list   # automatically uses the self-hosted URL
```

### Org scoping

PATs are bound to one org at mint time, so `-o`/`QF_ORG` is **not required**
for typical CLI use — the profile already knows the org. Pass `-o <suid>` only
when the token can access multiple orgs (e.g. an account-scoped token).

## Workflows

```bash
# List
quickflo workflows list                                     # table, top 50 by updatedAt
quickflo workflows list -j | jq                             # JSON for scripting
quickflo workflows list --where name:re:'^Free'             # regex on name
quickflo workflows list --tags stripe,billing               # OR by tag
quickflo workflows list --all -j > all-workflows.json       # paginate everything

# Get one
quickflo workflows get 'My Workflow'                        # auto-detect (UUID | name)
quickflo workflows get abcd > my-workflow.json              # save pushable shape
quickflo workflows get 'My Workflow' --by name              # disambiguate
quickflo workflows get abcd -j                              # raw API record

# Delete (removes the workflow + its triggers + execution history)
quickflo workflows delete 'My Workflow'                     # confirm prompt
quickflo workflows delete abcd --yes                        # no prompt

# Push (upsert every *.json in a directory)
quickflo workflows push -d ./workflows
quickflo workflows push -d ./workflows -w                   # + create webhook triggers
quickflo workflows push -d ./workflows -w --regenerate-secrets
quickflo workflows push -d ./workflows --dry-run

# Pull (download to a local directory)
quickflo workflows pull -d ./workflows
quickflo workflows pull -n 'Free Tool' -d ./free-tools      # name substring
quickflo workflows pull --where name:re:'^Free' -d ./free
quickflo workflows pull -d ./workflows --force              # overwrite local divergence
quickflo workflows pull -d ./workflows --dry-run

# Validate (server-side; no save, no run) — alias: check
quickflo workflows validate ./my-wf.json -o abcd            # { ok, errors, warnings }
quickflo workflows validate ./my-wf.json --strict -j        # warnings fail too; JSON out
cat ./my-wf.json | quickflo workflows validate --from-stdin -o abcd
```

## Agent skill

Install the QuickFlo agent skill — the operating guide + workflow-authoring conventions
for driving this CLI — into any agent harness. The guides ship **embedded in the CLI**, so
installs need no repo checkout and no network:

```bash
quickflo skill install                               # Claude skill → ~/.claude/skills/quickflo
quickflo skill install agents ~/.codex/AGENTS.md     # Codex / agents.md
quickflo skill install mcp                           # print the MCP host-config snippet

# No quickflo installed yet? One shot, no repo:
deno run -A jsr:@quickflo/cli skill install
```

| Harness            | What it writes                                                       | Loading                     |
| ------------------ | -------------------------------------------------------------------- | --------------------------- |
| `claude` (default) | `SKILL.md` + `building-workflows.md` in `~/.claude/skills/quickflo/` | lazy (description-gated)    |
| `agents`           | `AGENTS.md` (Codex: `~/.codex/AGENTS.md`, or repo root)              | eager (always-on)           |
| `mcp`              | prints the MCP host config (see below)                               | tools + on-demand resources |

For **tools**, prefer the MCP server below — it serves these same guides as `quickflo://`
resources, so MCP hosts get the how-to with no skill file.

## MCP server

`quickflo mcp` runs a stdio [MCP](https://modelcontextprotocol.io) server so an AI
agent (Claude Code, Claude Desktop, Cursor) can build workflows with typed tools:

- `list_steps`, `get_step_schema`, `list_connections` — introspect the catalog
- `validate_workflow` — the compiler loop (undefined/forward references, unknown
  filters/fields, missing connections); run after every edit
- `save_workflow_draft` — create/update a workflow as a draft (no triggers, no
  execution; server validates on save)

It authenticates with your active CLI profile (`quickflo auth login` first) and is
a thin client — all validation lives server-side. Add it to your MCP host config:

```json
{
  "mcpServers": {
    "quickflo": {
      "command": "quickflo",
      "args": ["mcp"],
      "env": { "QF_ORG": "abcd" }
    }
  }
}
```

(If `quickflo` isn't on PATH, use `"command": "deno"`, `"args": ["run", "-A",
"/path/to/quickflo-cli/mod.ts", "mcp"]`.) Set `QF_ORG` to your org, or pass `org`
per tool call. stdio only for now — claude.ai web (remote transport) is a
follow-up.

## Packages

Solution bundles — workflows + envs + connections + data stores + triggers — published once and
installed cross-org.

```bash
# List
quickflo packages list                                       # what this org has published
quickflo packages list --installed                           # what's installed into this org

# Install
quickflo packages install @acme/onboarding                   # canonical address
quickflo packages install qfi_AbC123…                        # unlisted-install token (URL or bare)
quickflo packages install ./onboarding-1.0.0.qfpkg.zip       # local file
quickflo packages install @acme/onboarding --dry-run         # preview only

# Download
quickflo packages download @acme/onboarding                  # latest version
quickflo packages download @acme/onboarding@1.2.0            # pinned version
quickflo packages download @acme/onboarding --out ./vendor/onboarding.qfpkg.zip

# Publish (server builds the artifact from the org's resources)
quickflo packages publish my-pkg \
  --version 1.0.0 \
  --root workflow:abc123 \
  --root trigger:xyz789 \
  --readme ./README.md \
  --changelog ./CHANGELOG.md

quickflo packages publish my-pkg --descriptor ./pkg.json     # from descriptor file

# First publish auto-creates the package shell
quickflo packages publish onboarding \
  --name "Onboarding" --visibility public \
  --version 1.0.0 --root workflow:abc
```

`--readme` updates the package-level README before publishing the immutable
version. The server then snapshots that live README into the package artifact.

A descriptor file (`pkg.json`):

```json
{
  "version": "1.0.0",
  "summary": "Initial release",
  "description": "Onboarding flow with Slack alerts",
  "tags": ["sales", "slack"],
  "roots": [
    { "kind": "workflow", "workflowTemplateId": "abc-…" },
    { "kind": "trigger", "triggerId": "xyz-…" }
  ],
  "readme": "# Onboarding\n…",
  "changelog": "## 1.0.0\n- initial release"
}
```

## Connections

Saved credentials (OAuth grants, API keys) for external services. Two flows:
imperative `create`/`update` for day-to-day work, plus `pull`/`push` for
GitOps-style bulk management of API-key types.

```bash
# Inspect
quickflo connections list                                # table
quickflo connections types                               # type → auth (oauth | config) → provider
quickflo connections types schema stripe                 # JSON Schema for an API-key type
quickflo connections types schema slack                  # { oauth: true, provider, scopes }

# Create (API-key types)
quickflo connections create --type stripe --name billing \
  --config '{"apiKey":"sk_live_…"}'

quickflo connections create --type stripe --name billing \
  --from-file ./stripe.json

# Create (OAuth-typed: opens browser, polls until consent completes)
quickflo connections create --type slack --name prod-alerts
# (You must already be signed into the QuickFlo web UI in your default browser.)

# Update
quickflo connections update billing --name billing-prod                  # rename
quickflo connections update billing --config '{"apiKey":"sk_live_NEW"}'  # rotate (API-key)

# Round-trip via files
quickflo connections pull -d ./connections                # plaintext + .gitignore warning
quickflo connections pull -d ./connections --mask         # "***" placeholders
quickflo connections push -d ./connections                # upsert by name
# OAuth-typed entries are skipped on both pull (written to _skipped_oauth.json)
# and push (use `connections create` for those).

# Delete
quickflo connections delete billing-prod                  # confirm prompt
quickflo connections delete billing-prod --yes            # no prompt
```

## Environments

Per-env variable bags (config + secrets) that workflows reference at runtime.

```bash
# Inspect
quickflo environments list
quickflo environments vars staging                        # plaintext key/value
quickflo environments vars staging --mask                 # keys only (no decrypt)

# Create / update
quickflo environments create --name staging
quickflo environments create --name prod \
  --var DATABASE_URL=postgres://… \
  --var REDIS_URL=redis://…

quickflo environments update staging --name staging-blue  # rename

# Per-variable verbs
quickflo environments set staging FEATURE_FLAG true
quickflo environments unset staging FEATURE_FLAG

# Bulk round-trip via files
quickflo environments pull -d ./environments
quickflo environments push -d ./environments
quickflo environments push -d ./environments --prune      # delete remote-only vars

# Delete
quickflo environments delete staging                       # confirm prompt
```

## Triggers

Webhook / schedule / event / form entry points for workflows. First-class
resource — every verb except `create` is addressable by trigger ref alone, no
workflow needed. A `<ref>` is either a UUID or a trigger name; if the same
name lives on multiple workflows (e.g. customer-owned vs. package-installed
copies), pass `-w <workflow>` as a disambiguator.

`list` is org-wide by default and renders a `WORKFLOW` column with workflow
names plus a `PKG` column when any row was installed from a package; pass
`-w <workflow>` to scope to one workflow (both columns are then redundant
and hidden).

```bash
# Inspect
quickflo triggers list                                     # all triggers, all workflows
quickflo triggers list -w 'My Workflow'                    # scoped to one workflow
quickflo triggers get primary                              # by name (org-wide)
quickflo triggers get primary -w 'My Workflow'             # disambiguate by workflow
quickflo triggers get <trigger-uuid>                       # by UUID

# Create (the one verb that needs a workflow)
quickflo triggers create -w 'My Workflow' --type webhook --name primary
quickflo triggers create -w 'My Workflow' --type schedule --from-file ./daily.json

# Update / toggle
quickflo triggers update primary --enabled false
quickflo triggers update primary --from-file ./new-config.json
quickflo triggers enable primary
quickflo triggers disable primary

# Lifecycle
quickflo triggers rotate-secret primary                    # secret printed once
quickflo triggers duplicate primary --to 'Other Workflow' --name 'Copy'
quickflo triggers delete primary --yes
```

## Data stores

JSONB KV namespaced by table. Per-org persistent state for workflow runs.

```bash
# Tables
quickflo data-stores tables list
quickflo data-stores tables create cli-test
quickflo data-stores tables delete cli-test --yes

# Records — list paginates; use --all / --limit to control how much comes back
quickflo data-stores list cli-test                         # first page only (default 100)
quickflo data-stores list cli-test --all                   # walk every page
quickflo data-stores list cli-test --prefix user:
quickflo data-stores list cli-test --filter status:active --sort updatedAt --desc
quickflo data-stores list cli-test -j                      # full untruncated values as JSON
quickflo data-stores get cli-test user:abc                 # prints value JSON (pretty)
quickflo data-stores get cli-test user:abc -j              # compact value, no banner — pipe to jq
quickflo data-stores get cli-test user:abc --meta          # full record + timestamps

quickflo data-stores set cli-test user:abc '{"name":"Acme"}'
echo '{"name":"Acme"}' | quickflo data-stores set cli-test user:abc --from-stdin
quickflo data-stores set cli-test session:xyz '{}' --ttl 3600

quickflo data-stores delete cli-test user:abc --yes

# Round-trip / export — export takes the same query flags as list (prefix/filter/sort/limit)
quickflo data-stores import cli-test -f ./seed.json        # batched in chunks of 500
quickflo data-stores export cli-test --out ./snapshot.json # JSON array (default), all pages
quickflo data-stores export cli-test --format ndjson       # one {key,value} per line
quickflo data-stores export cli-test --format csv          # key,value columns (value is JSON)
quickflo data-stores export cli-test --filter kind:bulk --out ./subset.json
```

Import accepts either `[{key, value}, …]` or an object map `{key: value, …}`.
Export defaults to the JSON array form (`--format json`); `ndjson` and `json`
round-trip back through `import`, while `csv` is for spreadsheets/inspection.
Unlike `list`, `export` always paginates the full result set.

## Dashboards

Full dashboard management: CRUD, native round-trip, portable cross-org
export/import, data-source management, and direct analytics queries. Built so an
agent harness can author, verify, and operate dashboards end to end.

```bash
# CRUD
quickflo dashboards list                                   # org-owned dashboards
quickflo dashboards list --include-packages -j             # include package installs, as JSON
quickflo dashboards get "Ops Overview"                     # full dashboard + widgets (UUID or name)
quickflo dashboards get "Ops Overview" --sources           # also embed referenced data-source defs
quickflo dashboards create "Ops Overview" --timezone America/Los_Angeles
quickflo dashboards update "Ops Overview" --description "Q3 ops" --default
quickflo dashboards delete "Ops Overview" --yes

# Native pull/push — real ids, same-org round-trip (no source remapping)
quickflo dashboards pull -d ./dashboards                   # one self-contained JSON per dashboard
quickflo dashboards push -d ./dashboards --dry-run         # reconcile widgets + layout by id
quickflo dashboards push -d ./dashboards                   # PATCH meta, create/update/delete widgets, save layout

# Portable export/import — cross-org (alias-rewritten, maps sources by name)
quickflo dashboards export "Ops Overview" --out ./ops.json
quickflo dashboards import -f ./ops.json --name "Ops (staging)"
quickflo dashboards import -f ./ops.json --map ds-0="Calls" --dry-run

# Data sources — the schema layer widgets reference
quickflo dashboards sources list
quickflo dashboards sources get "Workflow Executions"      # full record incl. recordSchema
quickflo dashboards sources create -f ./source.json
quickflo dashboards sources update <id> -f ./source.json
quickflo dashboards sources refresh <id>                   # re-sample the underlying table's schema
quickflo dashboards sources sync <id>                      # trigger the source's sync workflow
quickflo dashboards sources distinct <id> region           # filter values for a dimension
quickflo dashboards sources delete <id> --yes

# Query — run exactly what a widget runs, to verify data before saving
quickflo dashboards meta                                   # measures + dimensions per source
quickflo dashboards query --source "Workflow Executions" --measure count
quickflo dashboards query -s "Workflow Executions" -m durationMsAvg -d status \
  --filter status:eq:completed --time-dimension timestamp --granularity day \
  --date-range "last 7 days" --limit 100
quickflo dashboards query -f ./query.json --raw             # raw AnalyticsQuery body; full result
```

`pull`/`push` are the same-org loop: edit a pulled JSON and push it back,
widgets reconcile by `id` (a UUID updates in place; any non-UUID id — e.g.
`"id": "conversion-card"` — creates a new widget and is mapped into the layout),
and widgets dropped from the file are deleted. Data sources are referenced by id
and must already exist; `--create-missing-sources` recreates embedded defs.

`export`/`import` are the cross-org loop: real source ids and their `ds_<uuid>`
query aliases are rewritten to stable export ids, and `import` maps them back
onto this org's sources by name (override per source with `--map`). With
`--source`, bare `--measure`/`--dimension` field names on `query` are
auto-prefixed with that source's alias; refs that already carry a `ds_…` prefix
pass through, so multi-source/join queries work too.

> Reaching these endpoints with an access token requires the API to run the
> dashboards controller under `UserOrAccessTokenGuard` (the same guard as
> workflows/environments). `dashboards:view` covers read + query; create,
> update, delete, and source mutations need `dashboards:admin`.

## Package lifecycle

End-to-end loop with no UI round-trips:

```bash
# 1. Scaffold a descriptor from existing workflows
quickflo packages init --name onboarding --roots "Welcome flow" -o myorg
# → writes pkg.json with workflow ids resolved

# 2. Publish (server builds the .qfpkg.zip from your org's resources)
quickflo packages publish onboarding --descriptor ./pkg.json -o myorg

# 3. Discover published versions
quickflo packages list-versions @myorg/onboarding -o myorg

# 4. Install into another org
quickflo packages install @myorg/onboarding@1.0.0 -o customer-org
# → returns the install id (UUID)

# 5. Upgrade an existing install (preview by default; --apply commits)
quickflo packages upgrade <install-id> --to 1.1.0 -o customer-org
quickflo packages upgrade <install-id> --to 1.1.0 --apply -o customer-org

# 6. Uninstall
quickflo packages uninstall <install-id> --yes -o customer-org
```

`packages upgrade` defaults to **preview-only** — it mirrors `terraform plan` /
`terraform apply` since reinstall is destructive (workflows can be added,
replaced, or removed). Use `--apply` once you're satisfied with the diff.

## Execution + observability

Close the **author → run → observe → fix** loop without leaving the terminal.

### Run a workflow manually

```bash
# Default: queue the run, wait for completion, exit with the run's status
quickflo workflows run my-wf --input '{"x":1}'

# Async: queue + print just the executionId (tail it later)
quickflo workflows run my-wf --input-file ./payload.json --mode async

# Override the environment used for variable resolution
quickflo workflows run my-wf --env staging --input '{}'

# Print selected step outputs after completion ('*' for all)
quickflo workflows run my-wf --show fetchUsers,transform --input '{}'

# Max seconds to wait for completion. Exits 124 if exceeded.
quickflo workflows run my-wf --input '{}' --timeout 30

# Persist the trace + one JSON file per step to disk on completion
quickflo workflows run my-wf --input '{}' \
  --save-trace ./trace.json --save-steps-to ./steps/
```

### Inspect executions

```bash
# Find recent failures
quickflo workflows executions list --status failed --since 1h

# Full trace metadata + step paths
quickflo workflows executions get <execution-id>

# One step's output
quickflo workflows executions logs <execution-id> --step fetchUsers

# Full trace data (and show secrets)
quickflo workflows executions logs <execution-id> --full --show-secrets

# Save the trace JSON to disk
quickflo workflows executions download <execution-id> --out ./trace.json

# Tail a running execution until terminal; persist on completion
quickflo workflows executions tail <execution-id> \
  --save-trace ./trace.json --save-steps-to ./steps/

# Re-run with the same initial input
quickflo workflows executions replay <execution-id>
```

### Validate before pushing

`workflows validate` runs locally with **zero network calls** by default — the
right tool for AI agents (instant feedback) and CI (no token needed for
syntactic checks).

```bash
quickflo workflows validate ./my-wf.json
cat ./my-wf.json | quickflo workflows validate --from-stdin
quickflo workflows validate ./my-wf.json -j           # JSON for CI
quickflo workflows validate ./my-wf.json --strict -o abcd  # + server schema check
```

Exits 0 on success, 3 on validation failure.

### Discover step types

```bash
quickflo workflows steps list             # table of every step type
quickflo workflows steps get http-request # input/output JSON schemas + example
```

### Test a connection

```bash
quickflo connections test my-stripe-conn
```

The server endpoint is not yet shipped on every deployment; the CLI surfaces a
clear "not implemented" error in that case so the flag set stays stable.

### AI-agent / CI loop

The shape of the workflow that makes the CLI worth using from an agent:

```bash
quickflo workflows validate ./patched.json -j || exit $?
quickflo workflows push -d ./workflows -y
quickflo workflows run my-wf --input "$INPUT" --timeout 60 \
  || quickflo workflows executions list --status failed --since 5m -j \
       | jq -r '.[0].id' \
       | xargs -I{} quickflo workflows executions logs {} --step "$FAILED_STEP"
```

## Non-interactive contract

Designed so scripts and agents can depend on stable behavior:

- **Auto-yes on confirm prompts when stdin is not a TTY** — matches `gh`, `npm`. Pass `--yes` explicitly in scripts to make intent visible.
- **`-j/--json` on every list/get/inspect command** — JSON payload to stdout, banner / progress to stderr.
- **`--quiet`** suppresses progress output; errors still print.
- **JSON error envelope** — when `-j` was passed, errors land on stderr as `{"error":{"code":"...","message":"...","status":...,"path":"...","details":...}}`.
- **Stable exit codes** — see [EXIT_CODES.md](./EXIT_CODES.md). `0` ok, `1` user error, `2` server error, `3` validation, `124` timeout, `130` interrupted.

## Filter DSL

`--where <field>:<op>:<value>` — repeatable, available on every list/pull command.

| op       | wire                            |
| -------- | ------------------------------- |
| `eq`     | `where[f][$eq]=v`               |
| `ne`     | `where[f][$ne]=v`               |
| `re`     | `where[f][$re]=v` (regex)       |
| `gt/gte` | `where[f][$gt]=v` / `$gte`      |
| `lt/lte` | `where[f][$lt]=v` / `$lte`      |
| `in/nin` | comma-split → repeated params   |
| `like`   | `where[f][$like]=v` (use `%…%`) |
| `ilike`  | case-insensitive `like`         |

Last-resort escape hatch:

```bash
quickflo workflows list --raw-query 'where[foo][$eq]=bar&options[orderBy][updatedAt]=DESC'
```

Sort + limit:

```bash
quickflo workflows list --order name:ASC --limit 10
```

## Pipe-friendly streams

Stdout is the payload; diagnostics go to stderr. Redirect freely:

```bash
quickflo workflows get abcd > wf.json           # JSON only
quickflo workflows list -j | jq '.[].name'       # clean pipe
quickflo workflows push -d ./wf -w > urls.txt   # just URL + secret lines
```

## Flags and env vars

Per-command:

| short | long        | env          | notes                                          |
| ----- | ----------- | ------------ | ---------------------------------------------- |
| `-o`  | `--org`     | `QF_ORG`     | Usually unnecessary — profile knows the org    |
| —     | `--api-url` | `QF_API_URL` | Only used by `auth login` and `QF_TOKEN` paths |

Auth-related:

| env          | purpose                                                   |
| ------------ | --------------------------------------------------------- |
| `QF_PROFILE` | Override the active profile for this shell session        |
| `QF_TOKEN`   | One-shot token, bypasses profiles entirely (CI use)       |
| `QF_API_URL` | Paired with `QF_TOKEN`; sets the API URL for the one-shot |

Tokens are never passed via flag — they live in env vars or the credentials
file. Keeps shell history clean and `--help` output safe to paste publicly.

## Development

```bash
deno task dev workflows list      # run from source
deno task test                    # run tests
deno task fmt                     # format
deno task lint                    # lint
deno task check                   # type-check
deno task compile                 # build single binary into ./dist/quickflo
deno task install                 # install to ~/.deno/bin/quickflo
```

## License

[Apache-2.0](./LICENSE).
