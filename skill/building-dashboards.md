# Building & editing QuickFlo dashboards

Read this when the task is to **author or modify a dashboard** (build one, add/edit widgets, fix a widget that looks wrong). The output is a dashboard JSON you `check` then `push`. Do **not** assume the platform monorepo is checked out locally — discover everything through the CLI.

The engine **fails silently on a bad field reference**. A missing key reads as NULL (Postgres) / `''` (ClickHouse), so a typo'd ref matches zero rows and never raises: the widget just renders empty. That single fact drives everything below. Never trust a widget you have not queried.

## Discover before building (CLI-first)

The server is the source of truth for what is queryable.

```bash
quickflo dashboards sources list                        # sources + dim/measure counts + the ds_ alias
quickflo dashboards meta -j                             # EVERY measure + dimension, exact ds_-prefixed names
quickflo dashboards sources get <src> -j                # one source's schema (fields, types, calc fields)
quickflo dashboards sources distinct <src> <dimension>  # the REAL values of a dimension
quickflo dashboards list -j                             # existing dashboards to learn patterns from
quickflo dashboards pull -d ./dashboards                # real files to copy as a scaffold
```

**Never invent a `ds_` alias or a field name.** Copy them from `meta`, character for character.

## Field references

Source-namespaced: `ds_<uuid-with-underscores>.<field>`. The field segment is the **exact schema key** — spaces, underscores, and case included. `ds_abc.CAMPAIGN TYPE` and `ds_abc.CAMPAIGN_TYPE` are different refs, and only the one matching the schema resolves. `check` catches this and suggests the right key, so lean on it rather than squinting.

Measures per source: `count`, `ratePerSecond` / `ratePerMinute` / `ratePerHour` / `ratePerDay`, and for numeric fields flagged as measures, `<field>Sum` / `Avg` / `Min` / `Max` / `CountDistinct`.

A dimension may carry an inline date bucket: `<field>:<bucket>` with `hourOfDay`, `dayOfWeek`, `day`, `month`, `quarter`, `year`, `15min`, `30min` (e.g. `ds_abc.recordTimestamp:hourOfDay`).

## The trap `check` cannot catch: value casing

`check` validates that a **field** exists. It cannot know which **value** you meant — both are legal strings. Filter matching is exact, and casing is **per-source, not a platform convention**. The same conceptual field really does differ between sources in the same org:

```bash
quickflo dashboards sources distinct "Five9 Call Log" "CALL TYPE"
# → 3rd party transfer, Inbound, Manual, Outbound, Preview, Station   ← Title Case

quickflo dashboards sources distinct "Campaign Feed" "CAMPAIGN TYPE"
# → OUTBOUND, PREVIEW, MANUAL                                          ← UPPERCASE
```

There is no house rule to infer from, so pattern-matching on a name you have seen elsewhere is guessing. **Always `sources distinct` before filtering on a value you have not personally seen in query results.** This is the single most common way a dashboard ends up confidently displaying nothing.

> **An empty `distinct` result is ambiguous.** It means "no values" OR "you got the field name wrong" — a bad dimension returns `[]` with no error, same as the query path. Confirm the name against `meta` before concluding the data is missing.

## Dashboard file format

`pull` writes one self-contained JSON per dashboard; `push` reads the same shape.

```json
{
  "id": "<uuid>",
  "name": "Ops Overview",
  "timezone": "America/New_York",
  "layout": [{ "widgetId": "<uuid or file-local id>", "x": 0, "y": 0, "w": 6, "h": 4 }],
  "widgets": [
    {
      "id": "<uuid>",
      "title": "Calls by campaign",
      "chartType": "bar",
      "dataSourceId": "<uuid>",
      "queryConfig": {
        "measures": ["ds_abc.count"],
        "dimensions": ["ds_abc.CAMPAIGN TYPE"],
        "filters": [{ "dimension": "ds_abc.CAMPAIGN TYPE", "operator": "equals", "values": ["OUTBOUND"] }],
        "order": { "ds_abc.count": "desc" },
        "limit": 20
      }
    }
  ]
}
```

Widget reconcile on `push` is by `id`: a **UUID** `id` updates that widget in place; any **non-UUID** id (e.g. `"conversion-card"`) creates a new one and wires it into the layout. Widgets removed from the file are deleted. Referenced data sources must already exist.

## Filtering

Three layers, all AND-ed at query time.

**Structured rows** — `filters: [{ dimension, operator, values }]`. Rows AND together. Within one `equals` row, multiple values are OR (SQL `IN`), so "status is A or B" is ONE row with two values. Operators: `equals`, `notEquals`, `contains`, `notContains`, `gt`, `gte`, `lt`, `lte`, `set`, `notSet`.

> Every operator except `equals` takes **exactly one** value. Give `notEquals` two values and the engine **silently drops the row** — the filter vanishes and the widget matches everything. "Not A and not B" is two `notEquals` rows.

**Formula filter** — `filterFormula`, a boolean expression string, for what structured rows cannot express: OR across *different* fields, NOT groups, nested logic, field-to-field comparison.

```json
"filterFormula": "IN([CAMPAIGN TYPE], 'OUTBOUND', 'PREVIEW') or retries > 3"
```

- `IN(field, 'A', 'B')` is a **function call**, not an infix `in`.
- Field names inside a formula are the **bare schema keys of the widget's own source** (no `ds_` prefix). Joined-source fields are not available.
- `[Bracket]` any key that is not a valid identifier (spaces, leading digit).
- The **text is the source of truth**. Never hand-author `filterExpression` — it is compiled from the text and any AST you write is overwritten.

**Dashboard global filters** — `filterConfig` on the dashboard renders the filter bar; `filterDefaults` preselects values.

Filters apply BEFORE aggregation (SQL `WHERE`), including on calculated fields — so do not duplicate a filter condition inside a calc-field formula.

## Chart types

- `stat-card` — one headline number (one measure, no dimensions).
- `bar` — categorical comparison; also top-N with `order` + `limit`.
- `line` / `area` — trends over time (needs a timeDimension with a granularity). Area emphasizes volume.
- `pie` / `doughnut` — share of a whole, LOW cardinality only (≤ ~8 values).
- `funnel` — ordered stage drop-off.
- `table` — raw rows, many columns. Good default for detail.
- `stats-table` — one row per dimension value, several measure columns (leaderboards).
- `pivot-table` — two dimensions (rows × columns), a measure in the cells.

Layout is a 12-column grid: stat-cards read well at `w=3 h=2`, charts at `w=6 h=4`, tables/pivots at `w=12 h=5`.

## The verify → check → push loop (do not skip)

Two different gates. Run both.

```bash
# 1. VERIFY the data: does this query return plausible rows?
quickflo dashboards query -s "Calls" -m count -d "CAMPAIGN TYPE"     # bare fields auto-prefix with the source alias
quickflo dashboards query -f ./q.json --raw                          # full queryConfig body

# 2. CHECK the config: server-side validation, your typechecker.
quickflo dashboards check ./dashboards/ops.json -j                   # exit 0 = clean, 3 = errors
cat ./ops.json | quickflo dashboards check --from-stdin -j

# 3. PUSH only after both are clean.
quickflo dashboards push -d ./dashboards --dry-run
quickflo dashboards push -d ./dashboards
```

`check` reports `{ ok, errors, warnings }` and today catches: field refs that do not exist (with a "did you mean"), refs belonging to a source the widget neither uses nor joins, unqualified refs, unknown `ds_` aliases, filter rows missing a dimension, and payload shape problems. It does **not** yet catch multi-value operator misuse or formula field refs — and it can never catch a wrong *value*. So `check` clean means the config is structurally sound, not that the widget is right. **Only a query proves that.**

**Zero rows is a failure, not a result.** If a query comes back empty, suspect, in order: value casing (`sources distinct`), the date range, then the field ref.

## Why the CLI beats the in-app builder

Lean on these; they are the reason to work here.

- **Git is your undo.** `pull` → commit → edit → `check` → `push`. Every change is diffable, reviewable, and revertable per-hunk, and it survives the session.
- **`--dry-run`** shows exactly what `push` would reconcile before it touches anything.
- **Bulk.** Edit ten dashboards in one pass; `export`/`import` moves them across orgs (sources remapped by name).

## Workflow when given a task

1. **Discover**: `sources list` → `meta -j` for exact names → `sources distinct` for any value you will filter on.
2. **Plan briefly**: state the widgets and why those chart types.
3. **Verify the data first**: `dashboards query` each widget's shape. If it returns nothing, fix that before writing any file.
4. **Write**: edit the pulled JSON (or a new file). Full contents, no fragments.
5. **Check**: `dashboards check <file> -j`, fix every error, re-run until exit 0.
6. **Push**: `--dry-run` first, then `push`. Confirm the active org.
7. **Explain** non-obvious choices (chart type, filter logic, calc fields).

Ambiguous request → ask before building. If no org/auth is available, say so rather than guessing field names.
