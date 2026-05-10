# QuickFlo CLI

Command-line interface for [QuickFlo](https://quickflo.app) — push and pull workflows, install and
publish packages, and manage your QuickFlo organization from your terminal.

Written in TypeScript, runs on [Deno](https://deno.com), distributed via
[JSR](https://jsr.io/@quickflo/cli) and pre-built binaries.

## Install

### Pre-built binary (recommended)

Download the binary for your platform from the
[latest release](https://github.com/QuickFlo/cli/releases/latest) and put it on your `PATH`. macOS /
Linux one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/QuickFlo/cli/main/install.sh | sh
```

### From JSR (requires Deno 2+)

```bash
deno install --global --force --name quickflo \
  --allow-net --allow-read --allow-env --allow-write \
  jsr:@quickflo/cli
```

Make sure `~/.deno/bin` is on your `PATH`.

### From source

```bash
git clone https://github.com/QuickFlo/cli.git
cd cli
deno task install
```

## Auth

The CLI authenticates with a Personal Access Token. Mint one in the QuickFlo
web UI under **Settings → Access Tokens**, then either store it locally:

```bash
quickflo auth login              # paste token at the prompt (input is hidden)
quickflo auth status             # show which token is in use and what it can access
quickflo auth logout             # clear stored token
```

…or set it as an env var (handy for CI):

```bash
export QF_TOKEN=qfp_xxx…
export QF_ORG=abcd               # only needed if the token can see multiple orgs
```

Resolution order: `QF_TOKEN` → stored token (`~/.config/quickflo/credentials.json`,
mode `0600`, keyed by API URL) → fail with a hint pointing to `quickflo auth login`.

The CLI defaults to QuickFlo's hosted production deployment. To target a
self-hosted or local instance, override the API URL:

```bash
export QF_API_URL=https://my-quickflo.example.com/api
```

Tokens are bound to the org they were minted in, so `-o`/`QF_ORG` becomes
optional once you've logged in — the CLI auto-resolves the org for you. Pass
`-o <suid>` only when the token grants access to multiple orgs.

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

| short | long        | env          |
| ----- | ----------- | ------------ |
| `-o`  | `--org`     | `QF_ORG`     |
| —     | `--api-url` | `QF_API_URL` |

Auth is taken from `QF_TOKEN` or the stored credential — never from a flag, so
tokens never end up in shell history. See [Auth](#auth) above.

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
