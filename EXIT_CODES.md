# Exit codes

The QuickFlo CLI uses stable exit codes so CI scripts and agents can branch on
outcomes without parsing stderr. These are part of the public contract.

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Success                                                                    |
| 1    | User error — bad flags, missing resource, 4xx from server, refused confirm |
| 2    | Server error — 5xx from server, transport failure                          |
| 3    | Validation failure — `workflows validate` found errors, schema mismatch    |
| 124  | Timeout — client-side `--timeout` cutoff fired (matches GNU `timeout`)     |
| 130  | Interrupted — Ctrl-C / SIGINT (matches shell convention `128 + SIGINT`)    |

## Output contract

- stdout is reserved for the command's machine-readable output (`-j/--json` payloads, raw resource data, piped streams)
- stderr is for human-readable progress, prompts, warnings, and errors
- with `-j`, errors are emitted to stderr as JSON: `{"error":{"code":"...","message":"...","status":...,"path":"...","details":...}}`
- finite commands emit one JSON document under `-j`; `workflows run -j` waits and emits one versioned result envelope
- live machine-readable progress is explicit (`--json-stream`) and uses JSONL: one compact, typed object per line

## Non-interactive behavior

- when stdin is not a TTY, confirm prompts auto-yes (matches `gh`, `npm`); pass `--yes` explicitly to make this intent visible in scripts
- `--quiet` suppresses progress output; errors still print to stderr
- every list/get/inspect command accepts `-j/--json` for structured output
