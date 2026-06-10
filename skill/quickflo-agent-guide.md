# Driving QuickFlo from the terminal

You drive the **QuickFlo platform** from the terminal with the `quickflo` command (a Deno binary). This guide maps the full command surface and the conventions to run it autonomously as an agent harness.

Source of truth for the CLI is the public repo **https://github.com/QuickFlo/cli** (`mod.ts`, `src/`, `README.md`, `EXIT_CODES.md`) — or read it directly if you have it checked out locally. When a command's behavior is ambiguous, run `quickflo <group> <cmd> --help` — every command self-documents. Do not guess flags.

## Operating contract (read first)

- **JSON-first.** Every list/get/inspect command takes `-j/--json`. Always pass `-j` when you're going to parse output programmatically — the human tables are for display only. Pipe JSON through `jq`.
- **stdout vs stderr.** stdout is reserved for machine-readable output (`-j` payloads, raw resource JSON, piped streams). stderr carries progress, prompts, warnings, errors. With `-j`, errors come back on stderr as JSON: `{"error":{"code","message","status","path","details"}}`.
- **`-j` implies `--quiet`.** Passing `-j/--json` also suppresses the `QuickFlo — <command>` status banner (API/Profile/Org lines), so even merged stdout+stderr is pure payload — ideal for chaining or capturing in a harness.
- **Exit codes are a stable contract — branch on them, don't parse stderr:**
  | Code | Meaning |
  | ---- | ------- |
  | 0 | Success |
  | 1 | User error (bad flags, missing resource, 4xx, refused confirm) |
  | 2 | Server error (5xx, transport failure) |
  | 3 | Validation failure (`workflows validate` found errors) |
  | 124 | Client-side `--timeout` cutoff fired |
  | 130 | Interrupted (Ctrl-C / SIGINT) |
- **Non-interactive safety.** When stdin is not a TTY, confirm prompts auto-yes (like `gh`/`npm`). For destructive ops (cancel/delete/uninstall) pass `--yes` explicitly to make intent visible, and `--dry-run` first when the command supports it.
- **`--quiet`** suppresses progress output; errors still print to stderr. Useful in scripted loops.

## Auth & org selection

Profiles are saved tokens, each bound to one org at mint time. Check who you are before doing anything stateful:

```bash
quickflo auth status          # active profile, API URL, org, token validity
quickflo auth list            # all saved profiles; active marked with *
quickflo auth use <name>      # switch active profile
```

**Resolution order** (first match wins): `QF_TOKEN` env var (one-shot, pairs with `QF_API_URL`, bypasses profiles — CI use) → `QF_PROFILE` env var (session override) → `currentProfile` in `~/.config/quickflo/credentials.json`.

Because a PAT is bound to its org, **`-o`/`QF_ORG` is usually unnecessary** — the profile already knows the org. Pass `-o <suid>` only for account-scoped tokens that span multiple orgs. Tokens are never passed as flags (they live in env or the credentials file).

> Before running anything that mutates or that targets a specific org, confirm `quickflo auth status` points at the org you intend. Profiles like `quickflo` (local) vs `quickflo-prod` vs per-customer orgs (`acme`, `<customer-b>`, …) are easy to mix up. **Default to the already-active profile; never silently switch orgs.** If the task implies a different org than the active one, surface that and confirm.

## Command map

Top-level groups: `auth · workflows · packages · microapp · connections · environments · triggers · data-stores · backup · mcp`.

### workflows — the core surface
```bash
quickflo workflows list [-j] [-n <substr>] [--where f:op:v] [--tags a,b] [--templates all|only|exclude] [--order updatedAt:DESC] [--limit N] [--all] [--include-packages]
quickflo workflows get <ref> [-j] [--by id|suid|name]      # ref auto-detects UUID/name; default emits *pushable* JSON, -j emits raw record
quickflo workflows validate|check [file] [--from-stdin] [--strict] [-j]   # exit 3 on errors; --strict treats warnings (e.g. missing connections) as failures
quickflo workflows run <ref> [--input '<json>' | --input-file <p> | --input-stdin] [--env <name>] [--mode sync|async] [--show ids] [--hide ids] [--timeout <s>] [--save-trace <p>] [--save-steps-to <dir>] [-j]
quickflo workflows steps list [-j]                          # full step-type catalog
quickflo workflows steps get <type> [-j]                    # one step type + input/output JSON Schemas
quickflo workflows pull -d <dir> [filters…] [--force] [--dry-run]    # download defs to disk
quickflo workflows push -d <dir> [-w] [--dry-run] [-c <n>]          # bulk upsert; respects sub-workflow dep order
quickflo workflows executions …                            # see below
```
Filter grammar for `--where` (workflows list/pull, executions): `<field>:<op>:<value>`, repeatable. Ops: `eq, ne, re, gt, gte, lt, lte, in, nin, like, ilike`. `-n/--name` is shorthand for `name:re:<substr>`.

### Building or editing a workflow definition

When the task is to **author or modify a workflow JSON** (build from scratch, edit a file, assemble a tool workflow for `ai.agent`), see the companion guide **`building-workflows.md`** (shipped alongside this guide; also available as the `quickflo://building-workflows` MCP resource). It carries the full definition format, LiquidJS template syntax, step-output field reference, control-flow + for-each rules, the tool-workflow contract (`name`/`description`/`initial` DSL/`tags`/`agentToolMetadata`), and the discovery commands (`workflows steps list`/`steps get <type> -j`) to inspect real schemas instead of guessing.

The non-negotiable loop there: **write → `quickflo workflows validate <file> -j` → fix every error → re-run until exit 0 → only then `push`.** `validate` (alias `check`) is the server-side typechecker — it catches undefined/forward step references, unknown Liquid filters, bad output fields, and tier/concurrency problems before they ever hit a run. Use **plain `validate`** in the loop (errors block; warnings such as a not-yet-created connection are advisory). Reserve `--strict` (which fails on warnings too) for an optional final pre-push gate. Never `push` an unvalidated definition.

### workflows executions — debugging runs
```bash
quickflo workflows executions list [--workflow <ref>] [--status running|success|failed|cancelled] [--since 30m|2h|1d] [--where …] [--attr <path>:<op>:<value> | --attr '*:<term>'] [--attr-contains <term>] [--attr-not-contains <term>] [--raw-query <qs>] [--order startedAt:DESC] [--limit 25] [--all] [-j]
quickflo workflows executions get <id> [-j]                # one execution with step paths
quickflo workflows executions logs <id> [--step <id>] [--step-path <jsonPath>] [--full] [--show-secrets]   # one step output, or --full trace
quickflo workflows executions download <id> [--out <p>] [--show-secrets]    # save full trace JSON
quickflo workflows executions tail <id> [--interval 2] [--timeout <s>] [--save-trace <p>] [--save-steps-to <dir>] [-j]   # poll to terminal state; exit 124 on timeout
quickflo workflows executions replay <id> [--mode sync|async] [--env <name>] [--timeout <s>] [-j]   # re-run with the original input
quickflo workflows executions cancel [ids…] [--workflow <ref>] [--status running] [--since …] [--yes] [-j]   # filter-mode cancels a matched set
quickflo workflows executions delete [ids…] [--yes]        # soft-delete (running rows auto-cancelled); restorable
quickflo workflows executions restore <ids…>               # only within EXECUTION_TRACE_RETENTION_DAYS
```

**`--where` vs `--attr`.** `--where <field>:<op>:<value>` filters **top-level columns** (id, status, workflowId, startedAt…). To filter by an execution's **indexed search attributes** — the dotted paths the UI shows in its "Search Attributes" panel, auto-extracted from the **return-step output** (`return.webhookResponse.body.operation`, `return.webhookResponse.statusCode`, …) plus any `x-searchable` input fields — use `--attr` (repeatable).

**First, discover which paths are indexed** (don't guess them). The exact key set lives on each execution's `searchAttributes` map — read it from a real run:

```bash
# pick a recent run of the workflow, then dump its indexed attributes (== the UI's Search Attributes panel)
ID=$(quickflo workflows executions list --workflow <ref> --limit 1 -j | jq -r '.[0].id')
quickflo workflows executions get "$ID" -j | jq '.searchAttributes'   # exact indexed keys + values; null = none indexed
```

`searchAttributes` is `null` when a workflow indexes nothing (no `x-searchable` inputs and no return step). The empirical map is ground truth for *that* run (return values only materialize at runtime; the ~20-attr cap may drop some). The static source is the definition: `quickflo workflows get <ref> -j | jq -r '[paths(scalars) as $p | select($p[-1]=="x-searchable") | ($p[1:-1] | map(select(. != "properties" and . != "items" and . != "inputSchema")) | join("."))] | unique'` lists the input fields marked `x-searchable: true` by their indexed key (e.g. `metadata.operationType`). Then filter:

```bash
# exact match on a return attribute (op = eq | ne | contains | ncontains; <path>:<value> defaults to eq)
quickflo workflows executions list --attr 'return.webhookResponse.body.operation:eq:DELETE' --since 1d -j
# combine attributes (AND) and stack with column filters
quickflo workflows executions list --attr 'return.webhookResponse.statusCode:eq:202' --status success -j
# match a value across ANY indexed attribute — the UI's `*:value` form (path `*` = all fields)
quickflo workflows executions list --attr '*:DELETE' -j              # = --attr-contains 'DELETE'
quickflo workflows executions list --attr '*:ncontains:spam' -j      # = --attr-not-contains 'spam'
# escape hatch: raw URLSearchParams (server form is where[searchAttributes.<path>]=<value>)
quickflo workflows executions list --raw-query 'where[searchAttributes.return.webhookResponse.body.eventId]==<id>'
```

The path `*` is the any-field search (the UI's `*:somesearch`) → server `$containsValue` / `$notContainsValue`; `--attr-contains` / `--attr-not-contains` are convenience aliases for it. Only fields marked `x-searchable` (inputs) and the return-step output are indexed — not arbitrary step outputs. Caps: ~20 attributes / 255 chars each per execution.

### Supporting groups (use `--help` for full flags)
```bash
quickflo connections   list|get|create|update|pull|push|delete|test|types
quickflo environments  list|get|create|update|pull|push|delete | set <env> <k> <v> | unset <env> <k> | vars <env>
quickflo triggers      list|get|create|update|delete|enable|disable|pull|push|rotate-secret|duplicate   # list --workflow scopes to one wf
quickflo data-stores   tables … | list <table> [query…] | get <table> <key> [--meta] | set <table> <key> [value] | delete <table> <key> | import <table> | export <table> [query…]
quickflo packages      list|list-versions|install|uninstall|upgrade|download|publish|init   # upgrade is plan/apply (preview, then --apply)
quickflo microapp      new <name> | stripe-sync [config]
quickflo backup        [-o <org>] [-d <dir>] [--dry-run] [--mask] [--include-packages] [--data-store-limit N]   # pull entire org to one folder
```

### data-stores — querying, paginating, and exporting entries

`tables list` shows a **KEYS** count per table from server-side metadata; `list <table>` reads the actual entries. Both **paginate** — a single request returns at most one page, so always reach for the pagination/query flags rather than assuming the first page is the whole table:

```bash
quickflo data-stores tables list                          # catalog + KEYS count per table
quickflo data-stores list <table>                         # first page only (default 100)
quickflo data-stores list <table> --all                   # walk every page to the end
quickflo data-stores list <table> --limit 500             # cap results
quickflo data-stores list <table> --prefix user:          # keys starting with "user:"
quickflo data-stores list <table> --filter status:active  # JSONB value filter (repeatable, AND-ed)
quickflo data-stores list <table> --sort updatedAt --desc # sort by key|createdAt|updatedAt
quickflo data-stores list <table> -j                      # full untruncated values as JSON
quickflo data-stores get <table> <key>                    # one entry's value (pretty JSON)
quickflo data-stores get <table> <key> -j                 # compact value, no banner — pipe to jq
quickflo data-stores get <table> <key> --meta -j          # full record (timestamps/expiry/ids), compact
```

The table view truncates each value to 80 chars; use `-j/--json` (or `export`) to get the full value. `--filter` is a server-side JSONB predicate — `field:value` for equality, repeat the flag to AND multiple conditions.

**Export** the same data (with the **same query flags** — `--prefix`, `--filter`, `--sort`/`--desc`, `--limit` — all flow through, and it always paginates the full result set):

```bash
quickflo data-stores export <table>                       # JSON array of {key,value} (default), all pages
quickflo data-stores export <table> --format ndjson       # one {key,value} per line (stream/grep-friendly)
quickflo data-stores export <table> --format csv          # key,value columns (value column is JSON)
quickflo data-stores export <table> --filter kind:bulk --out dump.json   # filtered, written to a file
```

The `json`/`ndjson` shapes round-trip back through `data-stores import <table>`. For very large tables, prefer `export --out <file>` (or `--limit`) over dumping inline.

### mcp — MCP server for agent hosts

`quickflo mcp` runs a stdio [MCP](https://modelcontextprotocol.io) server exposing workflow tools (`list_steps`, `get_step_schema`, `list_connections`, `validate_workflow`, `save_workflow_draft`) to MCP hosts (Claude Code/Desktop, Cursor). It is a long-running server for **host configuration, not interactive use** — do not invoke it as a step in a task. Auth comes from the active profile; org via `QF_ORG` or a per-tool `org` arg. Host config: `{ "command": "quickflo", "args": ["mcp"], "env": { "QF_ORG": "<suid>" } }`. See the CLI `README.md` for details.

## How to approach a task

1. **Orient.** `quickflo auth status` to confirm the active org. If the task names workflows/runs you don't know, `quickflo workflows list -j` (add `-n`/`--where`/`--tags` to narrow).
2. **Read before write.** Use `get`, `logs`, `executions get/list -j` to gather facts. Inspect workflow contents with `workflows get <ref>` (pushable JSON) and the step catalog with `workflows steps get <type> -j`.
3. **Parse with jq.** e.g. `quickflo workflows executions list --status failed --since 1d -j | jq -r '.[] | "\(.id)\t\(.startedAt)\t\(.workflowName)"'`. (Confirm the exact JSON shape from a sample before writing brittle jq.)
4. **Build/edit via the validate loop.** Authoring or changing a workflow JSON? Follow `building-workflows.md`: write → `quickflo workflows validate <file> -j` (exit 3 = errors) → fix → re-run until clean → `push`. Warnings (e.g. a missing connection) are advisory in the loop; add `--strict` only as a final gate. Never push an unvalidated definition.
5. **Run deliberately.** Default `--mode sync` waits and returns the trace; `--mode async` queues and returns an `executionId` you can `tail`. Persist evidence with `--save-trace` / `--save-steps-to` when debugging. Use `--input-file`/`--input-stdin` for non-trivial input rather than cramming JSON into the shell.
6. **Debug a failure** (common harness loop): `executions list --status failed --since <window> -j` → pick id → **download the trace to disk and `jq` it** (see "Working with traces" below) → fetch a specific failing step with `executions logs <id> --step <stepId>` if you need just one → `executions replay <id>` to reproduce after a fix.

## Working with traces (preferred pattern)

Execution traces can be large — a single step output may carry thousands of rows. **Never read a full trace inline.** Download it to disk first, then scan with `jq`. Use `/tmp` as scratch so it doesn't clutter the repo:

```bash
ID=<execution-id>
quickflo workflows executions download "$ID" --out "/tmp/qf-trace-$ID.json"
T="/tmp/qf-trace-$ID.json"

# Orient: top-level shape and step list without dumping the whole thing
jq 'keys' "$T"
jq -r '.steps[] | "\(.stepId)\t\(.type)\t\(.success)"' "$T"   # adjust paths to the real shape

# Drill into just the failing steps
jq '.steps[] | select(.success==false) | {stepId, type, error, output}' "$T"

# Peek at one step's output shallowly instead of printing megabytes
jq '.steps[] | select(.stepId=="<id>") | .output | (if type=="array" then {len: length, first: .[0]} else . end)' "$T"
```

Confirm the actual JSON shape from `jq 'keys'` / a small sample before writing deep `jq` paths — don't assume field names. For the same reason, prefer `--save-trace <path>` / `--save-steps-to <dir>` on `run`/`tail` (writing to `/tmp`) over piping a sync run's full trace through your context. `--save-steps-to` is ideal when you want one file per step to `jq` independently.

## Recipes

```bash
# Most recent failed runs in the last day → download the trace to /tmp, then jq it
quickflo workflows executions list --status failed --since 1d
quickflo workflows executions download <id> --out /tmp/qf-trace-<id>.json
jq '.steps[] | select(.success==false) | {stepId, error}' /tmp/qf-trace-<id>.json

# Tail an async run to completion and capture every step output (one file per step, in /tmp)
EID=$(quickflo workflows run my-wf --input-file /tmp/in.json --mode async -j | jq -r '.executionId')
quickflo workflows executions tail "$EID" --save-steps-to /tmp/qf-steps-$EID --timeout 600
jq '.success' /tmp/qf-steps-$EID/*.json   # scan per-step files individually

# Author/edit → validate → push loop (see building-workflows.md for the full guide)
quickflo workflows steps get core.http -j | jq '.inputSchema'        # check the schema before configuring
# …write ./wf-dir/my-wf.json…
until quickflo workflows validate ./wf-dir/my-wf.json -j; do echo "fix errors (exit $?), re-run"; break; done
quickflo workflows validate ./wf-dir/my-wf.json --strict -j            # optional final gate: warnings (e.g. missing connection) fail too
quickflo workflows push -d ./wf-dir --dry-run                          # preview, only after a clean validate
quickflo workflows push -d ./wf-dir

# Snapshot a workflow's current contents to disk
quickflo workflows get 'Lead Dedupe' -j > ./snapshot/lead-dedupe.raw.json
quickflo workflows get 'Lead Dedupe'    > ./snapshot/lead-dedupe.pushable.json

# Inspect a step type's input schema before authoring config
quickflo workflows steps get core.http -j | jq '.inputSchema'

# Full org backup (dry-run first), secrets masked
quickflo backup --dry-run -o acme
quickflo backup -d ./snapshots/acme --mask -o acme
```

## Cautions

- `--show-secrets` (on run/tail/logs/download) writes secret values to disk in plaintext. Default off; only use when explicitly needed and tell the user where the file landed.
- `executions cancel/delete` in **filter mode** (`--workflow`/`--status`/`--since`/`--where`) can hit many rows. Preview the set with the matching `executions list` first, then pass `--yes` knowingly.
- `packages uninstall <install-id>` deletes **every resource the install created** — workflows, triggers, data, etc. Confirm the install-id with `packages list -j` before running.
- `workflows push` writes definitions live — only push a workflow that passed `validate` clean. `-w` creates webhook triggers; `--regenerate-secrets` rotates existing ones. Use `--dry-run` to see the plan.
- Mutations on a `*-prod` or customer profile are real production changes. Confirm the active org and prefer read-only inspection unless the user explicitly asked to mutate.

When you finish, report: which org/profile you operated against, the exact commands run, and the outcome (with exit codes for any failures).
