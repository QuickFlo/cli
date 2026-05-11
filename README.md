# QuickFlo CLI

Command-line interface for [QuickFlo](https://quickflo.app) — push and pull workflows, install and
publish packages, and manage your QuickFlo organization from your terminal.

Written in TypeScript, runs on [Deno](https://deno.com), distributed via
[JSR](https://jsr.io/@quickflo/cli).

## Install

Requires [Deno](https://deno.com) 2+.

```bash
deno install --global --force --name quickflo \
  --allow-net --allow-read --allow-env --allow-write \
  jsr:@quickflo/cli
```

Make sure `~/.deno/bin` is on your `PATH`.

### Upgrade

Re-run the same install command. The `--force` flag overwrites the existing binary with the latest
published version.

```bash
deno install --global --force --name quickflo \
  --allow-net --allow-read --allow-env --allow-write \
  jsr:@quickflo/cli
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
