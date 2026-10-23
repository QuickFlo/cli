# Authoring packages and configuring package settings

Read this guide when creating/modifying a package, publishing a version, or configuring an installed package's settings. Use `quickflo packages … --help` for flags. The backend owns artifact assembly and settings validation; the CLI passes reviewed declarations and edits to it.

## Authoring loop

1. Inspect the package's workflows and the data-store records they consume. Identify the actual key, value types, units, valid values, missing/empty behavior, and runtime-owned fields. Sample data suggests structure; it does not establish requiredness, an enum, or safe defaults. Inspect workflow conditions/fallbacks or ask for the missing product decision when semantics are unclear.
2. For an existing package, get its id/version with `packages list -j` / `packages list-versions <@org/name> -j`, then run `packages settings published <package-id> <version> -j`. Reuse those declarations in the next descriptor; publishing does not implicitly inherit them. Preserve existing keys, paths, unrelated roots and field metadata when editing one setting.
3. Author the settings source on an explicit `data-store-table` root in a publish descriptor. Set `includeSeedRows: true`. Review every exposed field using the field rules below, including fields inferred from samples. A type-only schema is an unfinished settings page.
4. Check the declaration against real record shapes and workflow expectations, inspect the UI authoring preview when available, and review shipped seed rows. `publish --dry-run` previews operations; it does **not** run the server's schema validator. Publishing validates the contract, including a singleton's `initialValue`, but does not prove every shipped or existing row satisfies it.
5. Publish with `packages publish <package> --descriptor <file>`. Do not combine a settings descriptor with `--root`: that flag replaces the whole roots array, and the CLI rejects this combination. Read the published declarations back to confirm they were retained. For a requested install/configuration task, follow the installed-settings loop below.

## Decide every field's presentation and behavior

Keep the persisted property key stable; use metadata for presentation. For each setting, explicitly decide its label, help text, control, requiredness, constraints/choices, default policy and editability. Do not fill these by mechanically title-casing keys and marking everything required.

| Decision | Supported schema | Authoring rule |
| --- | --- | --- |
| Display label | `title` on the property | Use a short user-facing label; include units where helpful, e.g. “Sync interval (seconds)”. Renaming a label must not rename the stored key. |
| Hint / help text | `description` on the property | Explain what changing the value does, units/format, and what blank/omitted/zero means when relevant. Give a useful example for mappings or structured inputs. Use the actual workflow behavior; do not invent a fallback. There is no separate supported `hint`, `helpText`, or placeholder attribute. |
| Requiredness | Property name in its **parent object's** `required` array | Require values the workflow needs to operate; optional values need a real omission/fallback behavior. `required` enforces presence, not truthiness: `false` and `0` remain valid if otherwise allowed. For nonempty text use `minLength: 1`; for a nonempty list use `minItems: 1`. Require each ancestor object too if a nested value must always exist. `required: true` on a property is invalid. |
| Value type | `type` | Match the stored JSON and workflow consumers: integer versus number, boolean versus string, dictionary versus fixed object. Do not change a stored type just to get a different-looking control. Optional means absent, not nullable; type unions are unsupported. |
| Choices | `enum`, optional `x-enum-labels` | Store the exact values consumed by the workflow; use friendly display labels separately. Only restrict to an enum when the domain is actually finite. Observed sample values are not an exhaustive enum. |
| Constraints | `minimum` / `maximum`, `minLength` / `maxLength`, `minItems` / `maxItems`, `uniqueItems`, supported `format` | Derive useful limits from downstream behavior; keep required fields, defaults and seeds consistent with them. Tightening a constraint can make existing installer records invalid; decide how those records will be repaired. |
| Suggested default | `default` on the property | Optional documentation/UI suggestion; it is not server-side coercion, migration or automatic backfill. The form shows scalar defaults as suggestions and does not save them just because the page opened. Preserve valid `false`, `0`, and empty values. |
| Creation defaults | Singleton `initialValue`; shipped `seedRows` come from the source table | A creatable singleton needs a complete explicit `initialValue` that satisfies its schema. Seed rows are separate actual publisher data bundled by the server. Review all shipped rows and omit customer-specific values, credentials and runtime state; do not blindly copy a sample as a creation default. |
| Editable / read-only | `writablePaths` and `readOnly` | Expose deliberate installer controls. A visible read-only field stays declared and out of writable paths. For hidden runtime fields omit the declaration and allow them in the surrounding stored object (`additionalProperties: true`); normal settings edits preserve them. Hidden does not mean secret storage. |
| Groups and documentation | Fixed nested `object` properties, `title`, `description` | Keep the structure consumed by workflows. Fixed objects flatten into sections derived from the first path segment; group descriptions appear as section notes. Do not invent layout metadata or rename persisted keys merely to change a section label. |

Write help that supports a decision: “Seconds between sync attempts. Lower values poll more often; minimum 10.” is useful; “Set the sync interval” is not. If a source `_note` accurately explains an object, adapt it into that object's `description`; don't expose documentation as an editable setting. Collection notes that vary by record are not a universal field description.

## Choose the control using the supported schema

Package settings support a reviewed subset of QuickForms. Do not copy arbitrary extensions from workflow/form-trigger schemas.

| Intended control | Property declaration |
| --- | --- |
| Text input | `type: "string"` |
| Multiline text | `type: "string", format: "textarea"` |
| Number input | `type: "number"` or `"integer"`, with appropriate bounds |
| Boolean checkbox | `type: "boolean"` |
| Manual select | Scalar `type`, `enum`, optional `x-enum-labels` keyed by the stored values; string enums match the authoring select control |
| Email / date / date-time / time | `type: "string"` with the corresponding `format` |
| String list | `type: "array", items: { "type": "string" }`; add `x-render: "textarea-array"` for one item per line |
| Structured list | `type: "array"` with a complete `items` schema; declare every per-item member that must survive editing |
| String-to-string mapping | `type: "object", additionalProperties: { "type": "string" }, x-render: "keyvalue"`; set `x-quickforms-quasar: { keyLabel: "Source field", valueLabel: "Destination field" }` to explain the two columns |
| Fixed group | `type: "object", properties: { … }`, with required child names on that object |
| Five9 list picker | `type: "string", x-options-fetcher: { kind: "package-provider", provider: "five9.lists", connectionPeerDep: "<declared-connection-name>" }` |

Dynamic options use the installer's bound connection. The peer dependency must be a declared Five9 connection; do not embed publisher connection IDs or arbitrary URLs. Use `settings options` to discover current values rather than guessing list names. Do not combine a changing provider list with a static enum unless that restriction is intentional.

Unsupported fields include arbitrary `x-component`, `x-quasar-props`, `x-placeholder`, conditional expressions, arbitrary option-fetch URLs, `$ref`, regex `pattern`, `oneOf`/`anyOf`, and password/phone formats. If the desired behavior needs these, identify the platform gap rather than emitting a declaration that publishing will reject. Labels/help use `title`/`description`; the only supported `x-quickforms-quasar` settings are mapping column labels.

## Settings source and descriptor

Choose `singleton` for one known record key; choose `collection` for multiple records. Set `allowCreate` and `allowDelete` intentionally. Singletons always use `allowDelete: false`; collections use `keyLabel` and have no `initialValue`. Existing-record-only sources can set both permissions false.

Example publish descriptor fragment (add the package's other roots and metadata):

```json
{
  "version": "1.1.0",
  "roots": [
    {
      "kind": "data-store-table",
      "tableName": "sync_settings",
      "includeSeedRows": true,
      "settingsSource": {
        "schemaVersion": 1,
        "title": "Sync settings",
        "description": "Control how often records sync and whether changes are written.",
        "mode": "singleton",
        "key": "config",
        "allowCreate": true,
        "allowDelete": false,
        "initialValue": { "syncSeconds": 30, "dryRun": true },
        "valueSchema": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "syncSeconds": {
              "type": "integer",
              "title": "Sync interval (seconds)",
              "description": "Seconds between sync attempts. Lower values poll more often; minimum 10.",
              "minimum": 10,
              "default": 30
            },
            "dryRun": {
              "type": "boolean",
              "title": "Preview changes only",
              "description": "When enabled, report planned changes without writing to the destination.",
              "default": true
            }
          },
          "required": ["syncSeconds", "dryRun"]
        },
        "writablePaths": ["/syncSeconds", "/dryRun"]
      }
    }
  ]
}
```

Adapt semantics to the actual workflow before publishing this example. `settingsSource` here is the full declaration, not `true`.

`writablePaths` are nonoverlapping JSON pointers to declared editable object members. Escape `/` as `~1` and `~` as `~0`; dots in names stay literal. Prefer leaf paths for fixed groups so hidden siblings survive edits. Arrays and dictionaries are edited as whole values: use their field path, not indices or dynamic dictionary keys. Include all necessary array-item fields; projection drops undeclared item fields, so whole-array replacement can otherwise lose them. Writable objects/arrays must not contain read-only descendants.

Limits: root value schema must be an object; at most 256 schema nodes, 8 levels, 64 KiB schema JSON, and 256 KiB record JSON. Reserved/prototype keys are rejected. Do not assume general JSON Schema support beyond the reviewed subset above.

The server packages the declaration into `resources/data-store-tables/<table>.json` with `$schema: "data-store-table-resource@1"` and `settings`, plus a `settingsSource: true` discovery marker in the manifest. `.qfpkg` downloads/uploads already preserve this. Author through publish descriptors; there is no second settings store or standalone page artifact to maintain.

## Hints for individual collection records

Use `settingsSource.recordFieldDescriptions` when a field needs different help for a particular record. Keep shared help in the property's `description`; key overrides by exact record key, then JSON-pointer field path:

```json
{
  "recordFieldDescriptions": {
    "custom_source": {
      "/reportFolder": "Create this report and share its folder with the API user."
    }
  }
}
```

This fragment belongs inside a `mode: "collection"` settings source. Overrides replace only presentation text; stored values, validation, defaults and permissions stay shared. An omitted override uses the shared description; an empty string suppresses it. Remove an override to restore shared help. Record keys may refer to records created after installation. Paths must refer to declared fields or groups, with `/` and `~` escaped as `~1` and `~0`. Limits: 256 field hints total, 2,000 characters per hint, and 64 KiB for the override map. Expressions and value-based conditions are unsupported.

In the visual editor, select a record in **Installer preview**, choose a field, then set **Help text** to **Only <record>**. **Use shared hint** removes the override. Preview and installer search use the selected record's effective hints. Hidden-field overrides stay in the authoring draft but are omitted from publication.

Publish the full descriptor normally and read `packages settings published` back to verify the overrides survived. The server validates the contract; `--dry-run` does not. Deploy API and UI support before publishing to an older environment. The hints travel in the package artifact and reach existing installations on upgrade.

## Configure an installed package

Use the package settings commands, which enforce the installed contract and table aliases. Ordinary `data-stores set` does not enforce package-settings editable paths or version/revision checks; use it only for a separately requested raw-data repair with understood consequences.

```bash
quickflo packages list --installed -j
quickflo packages settings describe <install-id> -j
quickflo packages settings records <install-id> <source-id> --key config -j
# For a collection: omit --key; use --all or --after-key <last-key> to paginate.
quickflo packages settings options <install-id> <source-id> --path /listName --search customers -j
```

Use the source `id` from describe, not the resolved `tableName`. Read the installed version's schema, writable paths, create/delete permissions, values, validation `issues` and revisions. Resolve dynamic options through the bound connection; follow `nextCursor`, and treat disabled/unavailable options as unavailable choices.

Save a request file containing only intended edits:

```json
{
  "key": "config",
  "packageVersionId": "<exact packageVersionId from describe>",
  "revision": "<exact revision from records>",
  "changes": [
    { "operation": "set", "path": "/syncSeconds", "value": 60 }
  ]
}
```

```bash
quickflo packages settings save <install-id> <source-id> --file changes.json --dry-run -j
quickflo packages settings save <install-id> <source-id> --file changes.json -j
```

A `set` value must be correctly typed JSON. Use `{ "operation": "remove", "path": "/optionalField" }` to omit an optional value; `null`, empty string, `false`, and `0` have different meanings. Each changed path must exactly match a declared writable path and appear once. Never send the entire projected record as a replacement.

Creation uses `revision: null` and requires `allowCreate`. A missing singleton is read as its `initialValue` with a null revision; reading does not persist it. Collections start from an empty object, so supply all required values when creating. Successful saves return records and their new revisions. On HTTP 409, reread the declaration and record, reconcile the user's changes, then submit deliberately; do not blindly retry with a fresh revision or null.

For a permitted collection deletion, create a file with only `key`, `packageVersionId`, and the non-null `revision` just read, then use `settings delete <install-id> <source-id> --file delete.json --dry-run -j` followed by `--yes -j` when authorized. Singleton deletion is forbidden. Dry runs print the proposed request; they do not prove contract validity or permission.

Definitions are pinned to the installed package version; values live in the installer's data store. Publishing a new version alone does not change an installed schema or migrate existing values. Preserve customer values during routine settings edits; schema evolution and any explicit reseeding/repair are separate decisions.
