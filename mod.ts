#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-write
/**
 * QuickFlo CLI — entrypoint.
 *
 * Install from JSR:
 *   deno install --global --force --name quickflo \
 *     --allow-net --allow-read --allow-env --allow-write \
 *     jsr:@quickflo/cli
 *
 * Or, in a clone of this repo:
 *   deno task install
 *
 * Auth: token-based. Run `quickflo auth login` to paste a token from the
 * QuickFlo web UI, or set `QF_TOKEN` in your env.
 */

import { Command, EnumType } from '@cliffy/command';
import { runAuthList, runAuthLogin, runAuthLogout, runAuthStatus, runAuthUse } from './src/auth.ts';
import { runWorkflowsPush } from './src/workflows-push.ts';
import { runWorkflowsPull } from './src/workflows-pull.ts';
import { runWorkflowsList } from './src/workflows-list.ts';
import { runWorkflowsGet } from './src/workflows-get.ts';
import { runPackagesList } from './src/packages-list.ts';
import { runPackagesInstall } from './src/packages-install.ts';
import { runPackagesPublish } from './src/packages-publish.ts';
import { runPackagesDownload } from './src/packages-download.ts';

const byType = new EnumType(['id', 'suid', 'name']);

const authLogin = new Command()
  .description(
    'Sign in by pasting an access token (mint one in the QuickFlo web UI under Settings → Access Tokens). Saves as a named profile and makes it active.',
  )
  .option('--api-url <url:string>', 'API base URL the token belongs to (or set QF_API_URL)')
  .option(
    '--as <name:string>',
    'Profile name to save under. Defaults to the org SUID.',
  )
  .example('Sign in (auto-named from org SUID)', 'quickflo auth login')
  .example(
    'Sign in with an explicit profile name',
    'quickflo auth login --as personal',
  )
  .example(
    'Sign in to a self-hosted deployment',
    'quickflo auth login --api-url https://quickflo.example.com/api',
  )
  .action(async (opts) => {
    await runAuthLogin({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      as: opts.as,
    });
  });

const authLogout = new Command()
  .description(
    'Remove a profile. With no argument, removes the active profile.',
  )
  .arguments('[profile:string]')
  .action(async (_opts, profile) => {
    await runAuthLogout({ profile });
  });

const authStatus = new Command()
  .description(
    'Show the active profile (or QF_TOKEN env) and verify the token still works.',
  )
  .option('-j, --json', 'Emit JSON instead of the table', { default: false })
  .action(async (opts) => {
    await runAuthStatus({ json: opts.json });
  });

const authList = new Command()
  .description('List saved profiles. The active one is marked with *.')
  .option('-j, --json', 'Emit JSON instead of the table', { default: false })
  .action(async (opts) => {
    await runAuthList({ json: opts.json });
  });

const authUse = new Command()
  .description('Switch the active profile.')
  .arguments('<name:string>')
  .example('Switch to a saved profile', 'quickflo auth use acme')
  .action(async (_opts, name) => {
    await runAuthUse({ name });
  });

const auth = new Command()
  .description('Manage authentication for the QuickFlo CLI.')
  .command('login', authLogin)
  .command('logout', authLogout)
  .command('status', authStatus)
  .command('list', authList)
  .command('use', authUse);

const workflowsPush = new Command()
  .description('Bulk upsert workflow definitions from a directory.')
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Directory of workflow JSON files', {
    default: './workflows',
  })
  .option(
    '-w, --create-triggers',
    'Create webhook triggers for each workflow',
    {
      default: false,
    },
  )
  .option(
    '--regenerate-secrets',
    'Force-rotate webhook secrets on existing triggers',
    { default: false, depends: ['create-triggers'] },
  )
  .option('--dry-run', 'Print the plan without making any changes', {
    default: false,
  })
  .option(
    '-c, --concurrency <n:number>',
    'Max workflows to push in parallel. Respects sub-workflow dep order — a file only starts after its in-set deps finish. 1 = strictly sequential.',
    { default: 8 },
  )
  .example(
    'Push + create triggers',
    'quickflo workflows push -d ./my-workflows -w -o abcd',
  )
  .example('Dry-run', 'quickflo workflows push --dry-run -o abcd')
  .example(
    'High-concurrency bulk push',
    'quickflo workflows push -d ./my-workflows -c 32 -o abcd',
  )
  .action(async (opts) => {
    await runWorkflowsPush({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      dryRun: opts.dryRun,
      createTriggers: opts.createTriggers,
      regenerateSecrets: opts.regenerateSecrets,
      concurrency: opts.concurrency,
    });
  });

const workflowsPull = new Command()
  .description(
    'Download workflow definitions from an org to a local directory.',
  )
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Destination directory for JSON files', {
    default: './workflows',
  })
  .option(
    '-n, --name <substr:string>',
    'Substring match on workflow name (shorthand for --where name:re:<substr>)',
  )
  .option(
    '--where <expr:string>',
    'Filter expression <field>:<op>:<value>. Repeatable. Ops: eq, ne, re, gt, gte, lt, lte, in, nin, like, ilike',
    { collect: true },
  )
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]')
  .option('--limit <n:number>', 'Max results')
  .option(
    '--raw-query <qs:string>',
    "Raw URLSearchParams passthrough (e.g. 'where[foo][$eq]=bar')",
  )
  .option('--force', 'Overwrite local files that differ from remote', {
    default: false,
  })
  .option('--dry-run', 'Print the plan without writing any files', {
    default: false,
  })
  .option(
    '--templates <mode:string>',
    'Template filter: all (default) | only | exclude',
    { default: 'all' },
  )
  .option(
    '-t, --tags <list:string>',
    'Filter by tags (comma-separated). Repeatable. OR semantics by default.',
    { collect: true },
  )
  .option(
    '--tags-all',
    'Require ALL --tags to be present (AND instead of OR)',
    {
      default: false,
    },
  )
  .option(
    '--include-packages',
    'Also pull workflows installed from packages (default: org-owned only)',
    { default: false },
  )
  .example('Pull all', 'quickflo workflows pull -d ./my-workflows -o abcd')
  .example(
    'Pull by name substring',
    "quickflo workflows pull -n 'Free Tool' -d ./free-tools -o abcd",
  )
  .example(
    'Pull via --where',
    "quickflo workflows pull --where name:re:'^Free' -d ./free -o abcd",
  )
  .example(
    'Pull by tag',
    'quickflo workflows pull --tags stripe -d ./stripe -o abcd',
  )
  .example(
    'Pull templates only',
    'quickflo workflows pull --templates only -d ./templates -o abcd',
  )
  .action(async (opts) => {
    await runWorkflowsPull({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      name: opts.name,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      rawQuery: opts.rawQuery,
      force: opts.force,
      dryRun: opts.dryRun,
      templates: opts.templates as 'all' | 'only' | 'exclude',
      tags: opts.tags,
      tagsAll: opts.tagsAll,
      includePackages: opts.includePackages,
    });
  });

const workflowsList = new Command()
  .description("Print the org's workflows as a table (or JSON).")
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '-n, --name <substr:string>',
    'Substring match on workflow name (shorthand for --where name:re:<substr>)',
  )
  .option(
    '--where <expr:string>',
    'Filter expression <field>:<op>:<value>. Repeatable.',
    { collect: true },
  )
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]', {
    default: 'updatedAt:DESC',
  })
  .option('--limit <n:number>', 'Max results (default 50)')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('-j, --json', 'Emit JSON instead of a table', { default: false })
  .option('--all', 'Paginate through every result', { default: false })
  .option(
    '--templates <mode:string>',
    'Template filter: all (default) | only | exclude',
    { default: 'all' },
  )
  .option(
    '-t, --tags <list:string>',
    'Filter by tags (comma-separated). Repeatable. OR semantics by default.',
    { collect: true },
  )
  .option(
    '--tags-all',
    'Require ALL --tags to be present (AND instead of OR)',
    {
      default: false,
    },
  )
  .option(
    '--include-packages',
    'Also list workflows installed from packages (default: org-owned only)',
    { default: false },
  )
  .example('Default table', 'quickflo workflows list -o abcd')
  .example('Templates only', 'quickflo workflows list --templates only -o abcd')
  .example('Filter by tag', 'quickflo workflows list --tags stripe -o abcd')
  .example(
    'Multiple tags (OR)',
    'quickflo workflows list --tags stripe,billing -o abcd',
  )
  .example(
    'Regex filter, JSON output',
    "quickflo workflows list --where name:re:'^Free' -j -o abcd",
  )
  .example(
    'Multiple filters',
    'quickflo workflows list --where name:re:Free --where createdAt:gt:2026-01-01 -o abcd',
  )
  .action(async (opts) => {
    await runWorkflowsList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      name: opts.name,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      rawQuery: opts.rawQuery,
      json: opts.json,
      all: opts.all,
      templates: opts.templates as 'all' | 'only' | 'exclude',
      tags: opts.tags,
      tagsAll: opts.tagsAll,
      includePackages: opts.includePackages,
    });
  });

const workflowsGet = new Command()
  .description(
    'Print one workflow as pushable JSON (auto-detects SUID / UUID / name).',
  )
  .type('by', byType)
  .arguments('<ref:string>')
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '--by <kind:by>',
    'Force lookup mode (id | suid | name). Default: auto-detect.',
  )
  .option('-j, --json', 'Emit the raw API record instead of pushable shape', {
    default: false,
  })
  .example('By SUID', 'quickflo workflows get abcd -o abcd')
  .example('By name', "quickflo workflows get 'My Workflow' --by name -o abcd")
  .example(
    'Save to a file',
    'quickflo workflows get abcd -o abcd > ./my-workflow.json',
  )
  .action(async (opts, ref) => {
    await runWorkflowsGet({
      ref,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflows = new Command()
  .description('Workflow management commands.')
  .command('list', workflowsList)
  .command('get', workflowsGet)
  .command('push', workflowsPush)
  .command('pull', workflowsPull);

const packagesList = new Command()
  .description(
    "Print the org's published or installed packages as a table (or JSON).",
  )
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '-i, --installed',
    'List packages installed into this org (default: list packages this org has published)',
    { default: false },
  )
  .option(
    '-n, --name <substr:string>',
    'Substring match on package name (shorthand for --where name:re:<substr>)',
  )
  .option(
    '--where <expr:string>',
    'Filter expression <field>:<op>:<value>. Repeatable.',
    { collect: true },
  )
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]', {
    default: 'updatedAt:DESC',
  })
  .option('--limit <n:number>', 'Max results (default 50)')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('-j, --json', 'Emit JSON instead of a table', { default: false })
  .option('--all', 'Paginate through every result', { default: false })
  .example('Published (default)', 'quickflo packages list -o abcd')
  .example('Installed', 'quickflo packages list --installed -o abcd')
  .example(
    'Filter by visibility',
    'quickflo packages list --where visibility:eq:public -o abcd',
  )
  .example('JSON output', 'quickflo packages list -j -o abcd')
  .action(async (opts) => {
    await runPackagesList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      installed: opts.installed,
      name: opts.name,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      rawQuery: opts.rawQuery,
      json: opts.json,
      all: opts.all,
    });
  });

const packagesInstall = new Command()
  .description(
    'Install a package into the active org. Resolves canonical addresses (@org/name), unlisted-install tokens (qfi_…), or local .qfpkg.zip files.',
  )
  .arguments('<ref:string>')
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '--dry-run',
    'Print the install preview and stop without committing',
    {
      default: false,
    },
  )
  .option(
    '--decisions <file:file>',
    'Override default install decisions with a JSON file matching CommitDecisions shape',
  )
  .option(
    '-j, --json',
    'After the human-readable summary, emit the preview/commit result as JSON',
    {
      default: false,
    },
  )
  .example(
    'Install by canonical address',
    'quickflo packages install @acme/onboarding -o myorg',
  )
  .example(
    'Install by unlisted token',
    'quickflo packages install qfi_AbC123… -o myorg',
  )
  .example(
    'Install from local file',
    'quickflo packages install ./onboarding-1.0.0.qfpkg.zip -o myorg',
  )
  .example(
    'Dry-run (preview only)',
    'quickflo packages install @acme/onboarding --dry-run -o myorg',
  )
  .action(async (opts, ref) => {
    await runPackagesInstall({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      dryRun: opts.dryRun,
      decisionsFile: opts.decisions,
      json: opts.json,
    });
  });

const visibilityType = new EnumType(['public', 'unlisted', 'private']);

const packagesPublish = new Command()
  .description(
    "Publish a new version of a package. Server assembles the .qfpkg.zip from the org's existing resources.",
  )
  .type('visibility', visibilityType)
  .arguments('<package:string>')
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '--descriptor <file:file>',
    'JSON file with the full publish payload (matches PublishPackageVersionDto)',
  )
  .option(
    '--version <semver:string>',
    'Version to publish (semver). Required if not in descriptor.',
  )
  .option(
    '-r, --root <expr:string>',
    'Root resource <kind>:<value>. Repeatable. Kinds: workflow, sub-workflow, trigger, data-store-table, dashboard.',
    { collect: true },
  )
  .option('--summary <text:string>', 'One-line release summary')
  .option(
    '--description <text:string>',
    'Long-form description (used on first-publish auto-create)',
  )
  .option('--icon <ref:string>', 'Icon name or URL')
  .option('--tags <list:string>', 'Tags (comma-separated). Repeatable.', {
    collect: true,
  })
  .option('--readme <file:file>', 'Path to a README markdown file')
  .option('--changelog <file:file>', 'Path to a release-notes markdown file')
  .option(
    '--name <text:string>',
    'Display name (required only when first-publish auto-creates the package)',
  )
  .option(
    '--visibility <kind:visibility>',
    'public | unlisted | private (used only on first-publish auto-create; defaults to private)',
  )
  .option(
    '--dry-run',
    'Print the resolved publish plan without making API calls',
    {
      default: false,
    },
  )
  .option(
    '-j, --json',
    'After the human-readable summary, emit the publish response as JSON',
    {
      default: false,
    },
  )
  .example(
    'Publish from descriptor',
    'quickflo packages publish my-pkg --descriptor ./pkg.json -o myorg',
  )
  .example(
    'Publish ad-hoc',
    'quickflo packages publish my-pkg --version 1.0.0 -r workflow:abc123 -r trigger:xyz789 -o myorg',
  )
  .example(
    'First-publish auto-create',
    'quickflo packages publish onboarding --name "Onboarding" --visibility public --version 1.0.0 -r workflow:abc -o myorg',
  )
  .action(async (opts, packageRef) => {
    const tags = (opts.tags ?? [])
      .flatMap((s: string) => s.split(','))
      .map((s) => s.trim())
      .filter((s: string) => s.length > 0);
    await runPackagesPublish({
      packageRef,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      descriptor: opts.descriptor,
      version: opts.version,
      summary: opts.summary,
      description: opts.description,
      icon: opts.icon,
      tags: tags.length > 0 ? tags : undefined,
      roots: opts.root,
      readmeFile: opts.readme,
      changelogFile: opts.changelog,
      name: opts.name,
      visibility: opts.visibility,
      dryRun: opts.dryRun,
      json: opts.json,
    });
  });

const packagesDownload = new Command()
  .description(
    'Download a package version artifact (.qfpkg.zip) to a local file. Resolves canonical addresses (@org/name, @org/name@version) or unlisted-install tokens (qfi_…).',
  )
  .arguments('<ref:string>')
  .option(
    '-o, --org <suid:string>',
    'Organization SUID or UUID (or set QF_ORG)',
  )
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '--out <path:string>',
    'Output file path (default: <slug>-<version>.qfpkg.zip in cwd)',
  )
  .option(
    '-j, --json',
    'After the human-readable summary, emit a JSON descriptor of the downloaded file',
    {
      default: false,
    },
  )
  .example(
    'Download latest by canonical address',
    'quickflo packages download @acme/onboarding -o myorg',
  )
  .example(
    'Download a pinned version',
    'quickflo packages download @acme/onboarding@1.2.0 -o myorg',
  )
  .example(
    'Download by unlisted token',
    'quickflo packages download qfi_AbC123… -o myorg',
  )
  .example(
    'Download to a specific path',
    'quickflo packages download @acme/onboarding --out ./vendor/onboarding.qfpkg.zip -o myorg',
  )
  .action(async (opts, ref) => {
    await runPackagesDownload({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      out: opts.out,
      json: opts.json,
    });
  });

const packages = new Command()
  .description(
    'Package management commands (export/import composable solution bundles).',
  )
  .command('list', packagesList)
  .command('install', packagesInstall)
  .command('download', packagesDownload)
  .command('publish', packagesPublish);

await new Command()
  .name('quickflo')
  .version('0.3.0')
  .description('QuickFlo command-line interface.')
  .command('auth', auth)
  .command('workflows', workflows)
  .command('packages', packages)
  .parse(Deno.args);
