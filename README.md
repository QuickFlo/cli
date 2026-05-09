# quickflo CLI

Command-line interface for [QuickFlo](https://quickflo.app) — push and pull workflows, install and
publish packages, and manage your QuickFlo organization from your terminal.

Written in TypeScript, runs on [Deno](https://deno.com), distributed via
[JSR](https://jsr.io/@quickflo/cli) and pre-built binaries.

## Install

### Pre-built binary (recommended)

Download the binary for your platform from the
[latest release](https://github.com/quickflo/cli/releases/latest) and put it on your `PATH`. macOS /
Linux one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/quickflo/cli/main/install.sh | sh
```

### From JSR (requires Deno 2+)

```bash
deno install --global --force --name quickflo \
  --allow-net --allow-read --allow-env --allow-write \
  jsr:@quickflo/cli/quickflo
```

Make sure `~/.deno/bin` is on your `PATH`.

### From source

```bash
git clone https://github.com/quickflo/cli.git
cd cli
deno task install
```

## Auth

Set these once and forget — every subcommand reads them.

```bash
export QF_USERNAME=you@example.com
export QF_PASSWORD='your-password'
export QF_ORG=abcd          # 4-char org SUID (or the org UUID)
```

The CLI defaults to QuickFlo's hosted production deployment. To target a self-hosted or local
instance, override the API and Supabase endpoints:

```bash
export QF_API_URL=https://my-quickflo.example.com/api
export QF_SUPABASE_URL=https://my-supabase.example.com
export QF_SUPABASE_ANON_KEY=eyJ…
```

Sessions cache at `~/.config/quickflo/session.json` (~1h TTL, auto-refreshed). Pass `--no-cache` to
force a fresh login.

## Workflows

```bash
# List
quickflo workflows list                                     # table, top 50 by updatedAt
quickflo workflows list -j | jq                             # JSON for scripting
quickflo workflows list --where name:re:'^Free'             # regex on name
quickflo workflows list --tags stripe,billing               # OR by tag
quickflo workflows list --all -j > all-workflows.json       # paginate everything

# Get one
quickflo workflows get abcd                                 # auto-detect (UUID | SUID | name)
quickflo workflows get abcd > my-workflow.json              # save pushable shape
quickflo workflows get 'My Workflow' --by name              # disambiguate
quickflo workflows get abcd -j                              # raw API record

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
```

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

## Flags every command takes

| short | long         | env           |
| ----- | ------------ | ------------- |
| `-u`  | `--username` | `QF_USERNAME` |
| `-p`  | `--password` | `QF_PASSWORD` |
| `-o`  | `--org`      | `QF_ORG`      |
| —     | `--api-url`  | `QF_API_URL`  |
| —     | `--no-cache` | —             |

For self-hosted or local development, set `QF_SUPABASE_URL` and `QF_SUPABASE_ANON_KEY` env vars
alongside `QF_API_URL` (these are env-var-only — pasting a 100-character JWT into every command is
no fun).

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
