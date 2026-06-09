# Building & editing QuickFlo workflows

Read this when the task is to **author or modify a workflow JSON definition** (build from scratch, edit an existing file, or assemble a tool workflow). The output is a complete workflow JSON the user can `push` or paste into the app. Do **not** assume the platform monorepo is checked out locally — discover everything through the CLI.

## Discover before building (CLI-first)

The server is the source of truth for what's available. Use these instead of reading repo source:

```bash
quickflo workflows steps list -j                 # step catalog: rows of { stepType, description, inputSchema, outputSchema, ui:{category,displayName} }
quickflo workflows steps get <stepType> -j        # one step's input/output JSON Schemas — read before configuring inputs
quickflo workflows list -j                        # find an existing workflow to learn patterns from
quickflo workflows get '<name>' -j                # read a real workflow as a reference implementation
quickflo workflows get '<name>' > ref.json        # pushable shape, good starting scaffold to copy
```

**Heads-up — the catalog endpoint may be empty.** `steps list`/`steps get` hit `/workflows/steps/info`, which is unpopulated in some deployments (the CLI prints "no step types returned" and `-j` emits `[]`). When that happens, fall back to learning real `stepType`s and `input` shapes from existing workflows: `quickflo workflows list -j` then `quickflo workflows get '<name>' -j | jq '.steps'`. If you're working inside the platform monorepo, the Zod schemas under `libs/steps/` are the definitive source.

**Never invent step types.** Confirm a `stepType` exists via the catalog or a real workflow before using it. **Always** verify a step's `input` shape (from `steps get`, an existing workflow, or the repo schema) before filling it — don't guess field names.

> If the platform monorepo *is* present (you're working inside it), the deeper canonical docs live at `libs/ai-engine/src/lib/builder/ai-builder-platform-guide.ts` (topic-keyed guide), `examples/` (reference workflows), and `libs/steps/` (Zod schemas). Read them when available. Otherwise the CLI discovery above is sufficient.

## Workflow definition format

```json
{
  "steps": [
    { "stepId": "descriptive-id", "stepType": "category.step-name", "input": { } }
  ],
  "initial": { "fieldName": "description or default value" }
}
```

- `stepId`: unique, lowercase-with-hyphens (`fetch-users`, `send-notification`).
- `stepType`: a real type from the catalog — never invented.
- `input`: object matching the step's schema — check the schema first.

## Template syntax (LiquidJS)

- `{{ stepId.field }}` — previous step output
- `{{ initial.field }}` — workflow input / trigger data
- `{{ $connections.name }}` — a configured connection
- `{{ $vars.name }}` — global variables (set by `core.set-variable`)
- `{{ $env.VAR }}` — environment variables
- `{{ $item.field }}` / `{{ $index }}` — for-each iteration context
- Single `{{ var }}` preserves type; mixed `"text {{ var }}"` returns a string.
- Filters: `{{ value | downcase }}`, `{{ price | times: 1.1 | round: 2 }}`.
- **No `||` operator** — use the `| default:` filter.
- **No nested `{{ }}`** — each expression is self-contained.
- In JSONLogic conditions (`core.if`/`switch`, `data.filter`/`reduce`/`classify`) reference fields with Liquid `"{{ field }}"`, never `{"var": "field"}`.

## Common output fields (don't guess these)

- `ai.llm-call` text mode: `{{ stepId.text }}` (NOT `.output`/`.data`)
- `ai.llm-call` structured mode: `{{ stepId.object.fieldName }}`
- `core.http`: `{{ stepId.body }}`, `{{ stepId.status }}`, `{{ stepId.headers }}` (NOT `.data`)

When unsure, the output shape is in `steps get <type> -j` under the output schema.

## Control flow

- **If**: `core.if` with `input.condition` (JSONLogic), `input.then`, `input.else`.
- **Switch**: `core.switch` with `input.cases` array and `input.default`.
- **For-Each**: `core.for-each` with `input.items` and `input.steps`.
- Steps after a container are convergence points — they run regardless of which branch ran.

### For-each constraints

- **`core.code` inside `core.for-each` forces `concurrency: 1`** — Deno execution is serialized within a for-each. For real cross-iteration parallelism, factor the code step into a sub-workflow (each invocation gets its own runtime) or restructure with `data.map` / `data.filter` (engine data path, not the Deno sandbox).
- **For-each output** exposes `.count`, `.succeeded`, `.failed`, and `.items[].output` (per-iteration step outputs keyed by stepId).

### Aggregating across iterations — pick the right tool

**Aggregate from `for-each.items[].output` in one final `core.code`** when: the loop is flat; you want a simple count/sum/tally; you want one place to look when numbers are wrong.

**Mutate `$vars` inside the loop** (`core.set-variable` with `{{ $vars.x | plus: ... }}`) when: you have nested loops (walking `items[].output['inner'].items[]...` is bug-prone; `$vars` reads the same at any depth); you need a stateful accumulator (running max, deduped Set); you want the running total visible mid-trace; or the producing step is likely to be renamed (`$vars` co-located with the producer is more refactor-resilient than hard-coded `items[].output['step-id']` paths).

**Caveat:** `$vars` mutation requires `concurrency: 1`. With `core.code` in the loop that's already forced. With pure data steps at `concurrency > 1`, mutations are non-deterministic — use the aggregate pattern. This is a preference, not a rule.

## Initial data

- Webhook body fields spread at root: `{{ initial.userId }}`.
- Full webhook detail: `{{ initial.webhook.body }}`, `{{ initial.webhook.query.param }}`, `{{ initial.webhook.headers.name }}`.
- Form fields at root: `{{ initial.name }}`.
- Always define matching `initial` fields in the definition.

## Best practices

- Put complex expressions in `core.set-variable`, reference via `{{ $vars.name }}`.
- For workflows beyond ~12-15 steps, decompose into sub-workflows.
- Prefer `core.if`/`core.switch` over `skipCondition`.
- `ai.llm-call` defaults: `webSearch: true` for anthropic/google; fast models by default (`claude-haiku-4-5-20251001`, `gpt-4.1-mini`, `gemini-2.5-flash`).

## Tool workflows (consumed by `ai.agent`)

When the workflow is meant to be called as a tool by an `ai.agent` step (or exported in a Tool Pack), four fields are load-bearing — the LLM selects the tool and assembles arguments purely from what's encoded. Required top-level fields: `name`, `description`, `isTemplate: true`, `tags` including `"tool"`.

### name
- Kebab-case, action-verb leading: `ucce-update-business-hours`, not `update_business_hours_v2`.
- The agent step runs `sanitizeToolName(name)` → lowercases + non-alphanumeric→`_`, so `ucce-update-business-hours` → `ucce_update_business_hours` for the LLM. Author the kebab form.
- Prefix with integration/domain (`ucce-`, `slack-`, `crm-`) so an agent with many tools doesn't see ambiguous `update`.

### description
`description` answers "should I reach for this tool, and when?" (selection); `inputSchema` answers "what goes in each field?" (argument assembly). Don't duplicate shape info — the DSL `initial` already produces typed properties with per-field descriptions.

**SHOULD cover** (things the schema can't express): action verb + side effect/post-condition ("full replacement not upsert", "refreshes changeStamp", "no-op when no matches"); disambiguators vs similar tools ("destructive", "idempotent", "bulk vs single"); pre-commit reasoning hints one altitude above the schema ("you'll need the refURL and the complete special-day list"); non-obvious format quirks ("dates are dd-MM-yyyy, not ISO").

**SHOULD NOT contain**: full per-field enumeration (that's `inputSchema.properties[*].description`); restated types or required/optional; "This tool/workflow" preamble — get to the verb.

Good: *"Replace the special-day schedule for a UCCE business hour. Full replacement (not upsert) — pass the complete list. Refreshes changeStamp; weekly schedule and metadata preserved. Dates are dd-MM-yyyy."*

### initial — the DSL parameter contract
The tool's `inputSchema` is built by `inferInputSchema` from `definition.initial`. Type-prefixed DSL strings become typed JSON Schema. Stored in `definition.initial`, not a separate `inputSchema` block.

| Prefix | Becomes | Example |
| --- | --- | --- |
| `string: desc` | `{type:'string', description}` | `"refURL": "string: UCCE refURL"` |
| `number: desc` | number | `"count": "number: Rows to fetch"` |
| `boolean: desc` | boolean | `"dryRun": "boolean: Skip side effects"` |
| `string[]: desc` | array of strings | `"tags": "string[]: Labels"` |
| `number[]: desc` / `boolean[]:` | typed arrays | |
| `object[]: desc` | generic object array (no item shape) | only when items are truly unstructured |
| `a\|b\|c: desc` | enum string | `"action": "send\|book\|cancel: The action"` |
| `<type>.optional: desc` | type unchanged, key omitted from `required` | `"clearAll": "boolean.optional: Wipe all"` |

**Typed arrays of objects → nest a one-element array with the item template** (not `object[]:`), so the LLM sees the per-item shape:
```json
"specialDaySchedule": [
  {
    "date": "string: dd-MM-yyyy",
    "startTime": "string.optional: HH:mm or empty for full-day Closed",
    "status": "number: 0=Closed, 1=Open",
    "statusReason": { "refURL": "string.optional: ...", "reasonText": "string.optional: ..." }
  }
]
```

**Nested objects → direct nesting** with DSL strings at the leaves. A key whose value is a plain nested object (no DSL prefix) is treated as required; `.optional` on leaves drives the nested `required` arrays.

When generating JSON, always use the nested JSON-mode form (the dialog's "Properties mode" flat dot-paths save into the same nested shape).

`initial` DSL strings never leak to runtime — `executeToolWorkflow` does `{ ...template.initial, ...args }`, so the agent's real args override. For standalone testing put real values in a separate `testData` block (the dialog's "Test" uses it).

### tags
Top-level array, NOT inside `agentToolMetadata`.
- **Always include `"tool"`** — the package builder auto-collects every `isTemplate=true` workflow tagged `tool` into `manifest.exports.tools[]`. No `tool` tag → not exported.
- Capability tags for `onlyTags`/`exceptTags` filtering at the agent step: `read`, `write`, `destructive`, `idempotent`. Query → `["tool","read",<domain>]`; update → `["tool","write",<domain>]`; delete → `["tool","write","destructive",<domain>]`.
- Add domain tags (`ucce`, `slack`) so pack consumers can filter by integration.

### agentToolMetadata (optional)
Top-level object alongside `tags`; controls runtime behavior, not discovery.
```json
"agentToolMetadata": {
  "requiresApproval": true,
  "approvalMessage": "About to delete {% if args.clearAll %}ALL{% else %}{{ args.dates | size }}{% endif %} entries from `{{ args.refURL }}`. Approve?"
}
```
- `requiresApproval: true` gates the tool behind chat-session approval. OR semantics with the consuming agent step — template flag wins; consumer can add but not disable. Default to `true` on destructive/mutating tools.
- `approvalMessage` is Liquid rendered against `{ toolName, args }`. **Standard LiquidJS only** — `size`, `join`, `default`, `upcase`, `downcase`, `truncate`, `replace`, `{% if %}`, `{% for %}` work; custom engine filters silently no-op.
- `toolName` — optional snake_case override; skip unless `sanitizeToolName(name)` is ugly.

### Error surfacing in tool workflows
The agent step catches sub-workflow throws and returns `{ toolError: { code:'TOOL_EXECUTION_FAILED', message, retryable:false } }` — the LLM sees a flat string and loses structured detail. To preserve diagnostics (HTTP status, body):
1. Set `continueOnError: true` on every `core.http` step inside the tool.
2. End with a `core.return` surfacing `success`, `status`, `body`, `error`. Failed calls then return as data the agent can read, not opaque failures.

## The write → validate → fix loop (do not skip)

`quickflo workflows validate` (alias `check`) is a **server-side validator** — treat it as your typechecker. Run it after every write/edit and loop until clean.

```bash
quickflo workflows validate <file.json> -j               # exit 0 = clean, 3 = errors found
# QF_ORG or -o <suid> targets the org; auth comes from the active profile (same one push/pull use)
cat <file.json> | quickflo workflows validate --from-stdin -j   # validate without a temp file
quickflo workflows validate <file.json> --strict -j      # FINAL gate only: warnings (e.g. missing connection) fail too
```

What it reports per file as `{ ok, errors, warnings }`:
- **Undefined step references** (error) — `{{ foo.body }}` where no step `foo` exists. Catches typos and hallucinated ids.
- **Forward / self references** (error) — a step can only read outputs of steps before it.
- **Unknown Liquid filters** (error) — misspelled/non-existent filter.
- **Unknown output fields** (warning) — `{{ http.bdoy }}` on a known closed output shape.
- **Worker-tier / concurrency problems** (error) — e.g. a `core.code` step on the wrong tier.

It does NOT type-check templated values (a `{{ }}` in a number field is fine — Liquid decides type at runtime), so a clean run means the structure is sound, not that every value is perfect.

**Use it as a loop, not a final gate.** Write → plain `validate` → fix errors → re-run until exit 0. Warnings (unknown output fields, missing connections) are **advisory — do not let them block the loop**: you routinely reference a connection before creating it. `--strict` promotes warnings to failures, so reserve it for a single final pre-push gate (and expect it to fail on any connection you reference but haven't created yet). Do not declare the workflow done while it reports errors. Only after a clean validate should you `quickflo workflows push -d <dir>` (or paste into the app). If no org/auth is available, say so and fall back to careful manual verification against `steps get` schemas.

## Workflow when given a task

1. **Discover**: `steps list`, `steps get <type>` for each step you'll use, and `get` a similar existing workflow if helpful.
2. **Plan briefly**: state the steps you'll use and why.
3. **Write**:
   - File path given → Write the **full** updated JSON to that file.
   - No file path → output the complete JSON in a fenced block to copy-paste.
4. **Validate**: run `quickflo workflows validate <file> -j`, fix every error, re-run until exit 0. (Warnings are advisory; use `--strict` only as a final pre-push gate — it also fails on a not-yet-created connection.)
5. **Explain** non-obvious choices (template expressions, control flow).
6. If the user wants it live: `quickflo workflows push -d <dir>` (only after a clean validate). Confirm the active org first.

Ambiguous request → ask clarifying questions before building.
