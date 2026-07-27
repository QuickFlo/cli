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
import { runWorkflowsDelete } from './src/workflows-delete.ts';
import { runPackagesList } from './src/packages-list.ts';
import { runPackagesInstall } from './src/packages-install.ts';
import { runPackagesPublish } from './src/packages-publish.ts';
import { runPackagesDownload } from './src/packages-download.ts';
import { runPackagesListVersions } from './src/packages-versions.ts';
import { runPackagesUninstall } from './src/packages-uninstall.ts';
import { runPackagesUpgrade } from './src/packages-upgrade.ts';
import { runPackagesInit } from './src/packages-init.ts';
import { runMicroappNew } from './src/microapp-new.ts';
import { runMicroappStripeSync } from './src/microapp-stripe-sync.ts';
import { runConnectionsList } from './src/connections-list.ts';
import { runConnectionsGet } from './src/connections-get.ts';
import { runConnectionsPull } from './src/connections-pull.ts';
import { runConnectionsPush } from './src/connections-push.ts';
import { runConnectionsDelete } from './src/connections-delete.ts';
import { runConnectionsCreate } from './src/connections-create.ts';
import { runConnectionsUpdate } from './src/connections-update.ts';
import { runConnectionsTypesList, runConnectionsTypesSchema } from './src/connections-types.ts';
import { runEnvironmentsList } from './src/environments-list.ts';
import { runEnvironmentsGet } from './src/environments-get.ts';
import { runEnvironmentsPull } from './src/environments-pull.ts';
import { runEnvironmentsPush } from './src/environments-push.ts';
import {
  runEnvironmentsVars,
  runEnvironmentsVarSet,
  runEnvironmentsVarUnset,
} from './src/environments-vars.ts';
import { runEnvironmentsDelete } from './src/environments-delete.ts';
import { runEnvironmentsCreate } from './src/environments-create.ts';
import { runEnvironmentsUpdate } from './src/environments-update.ts';
import { runTriggersList } from './src/triggers-list.ts';
import { runTriggersPull } from './src/triggers-pull.ts';
import { runTriggersPush } from './src/triggers-push.ts';
import { runTriggersGet } from './src/triggers-get.ts';
import { runTriggersCreate } from './src/triggers-create.ts';
import { runTriggersUpdate } from './src/triggers-update.ts';
import { runTriggersDelete } from './src/triggers-delete.ts';
import {
  runTriggersDisable,
  runTriggersDuplicate,
  runTriggersEnable,
  runTriggersRotateSecret,
} from './src/triggers-lifecycle.ts';
import {
  runDataStoresTablesCreate,
  runDataStoresTablesDelete,
  runDataStoresTablesList,
} from './src/data-stores-tables.ts';
import {
  runDataStoresRecordsDelete,
  runDataStoresRecordsGet,
  runDataStoresRecordsList,
  runDataStoresRecordsSet,
} from './src/data-stores-records.ts';
import { runDataStoresImport } from './src/data-stores-import.ts';
import { runBackup } from './src/backup.ts';
import { runDataStoresExport } from './src/data-stores-export.ts';
import { runDashboardsList } from './src/dashboards-list.ts';
import { runDashboardsGet } from './src/dashboards-get.ts';
import { runDashboardsCreate, runDashboardsUpdate } from './src/dashboards-save.ts';
import { runDashboardsDelete } from './src/dashboards-delete.ts';
import { runDashboardsPull } from './src/dashboards-pull.ts';
import { runDashboardsPush } from './src/dashboards-push.ts';
import { runDashboardsExport } from './src/dashboards-export.ts';
import { runDashboardsImport } from './src/dashboards-import.ts';
import { runDashboardsCheck } from './src/dashboards-check.ts';
import { runDashboardsMeta, runDashboardsQuery } from './src/dashboards-query.ts';
import {
  runSourcesCreate,
  runSourcesDelete,
  runSourcesDistinct,
  runSourcesGet,
  runSourcesList,
  runSourcesRefresh,
  runSourcesSync,
  runSourcesUpdate,
} from './src/dashboards-sources.ts';
import {
  runCalcFieldDelete,
  runCalcFieldSet,
  runSourceFieldsList,
  runWindowDimDelete,
  runWindowDimSet,
} from './src/dashboards-source-fields.ts';
import { setQuiet } from './src/log.ts';
import { printError } from './src/errors.ts';
import { runWorkflowsRun } from './src/workflows-run.ts';
import { runWorkflowsExecutionsList } from './src/workflows-executions-list.ts';
import { runWorkflowsExecutionsGet } from './src/workflows-executions-get.ts';
import { runWorkflowsExecutionsLogs } from './src/workflows-executions-logs.ts';
import { runWorkflowsExecutionsDownload } from './src/workflows-executions-download.ts';
import { runWorkflowsExecutionsReplay } from './src/workflows-executions-replay.ts';
import { runWorkflowsExecutionsTail } from './src/workflows-executions-tail.ts';
import { runWorkflowsExecutionsCancel } from './src/workflows-executions-cancel.ts';
import { runWorkflowsExecutionsDelete } from './src/workflows-executions-delete.ts';
import { runWorkflowsExecutionsRestore } from './src/workflows-executions-restore.ts';
import { runWorkflowsValidate } from './src/workflows-validate.ts';
import { runLogsFacets, runLogsSearch } from './src/logs.ts';
import { runMcp } from './src/mcp.ts';
import { runSkillInstall } from './src/skill-install.ts';
import { runWorkflowsStepsGet, runWorkflowsStepsList } from './src/workflows-steps.ts';
import { runConnectionsTest } from './src/connections-test.ts';

const byType = new EnumType(['id', 'suid', 'name']);
const runModeType = new EnumType(['sync', 'async']);
const respondAsType = new EnumType(['webhook', 'execution']);

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
    'Print one workflow as pushable JSON (auto-detects UUID / name; pass --by suid for the rare suid lookup).',
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
  .example('By name (default)', "quickflo workflows get 'My Workflow' -o abcd")
  .example('By UUID', 'quickflo workflows get 11111111-2222-3333-4444-555555555555 -o abcd')
  .example(
    'Save to a file',
    "quickflo workflows get 'My Workflow' -o abcd > ./my-workflow.json",
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

const workflowsDelete = new Command()
  .description(
    'Delete a workflow (and its triggers + execution history). Auto-detects UUID / name; force with --by.',
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
  .option('-y, --yes', 'Skip confirmation', { default: false })
  .example('By name (default)', "quickflo workflows delete 'My Workflow' -o abcd")
  .example(
    'By UUID, no prompt',
    'quickflo workflows delete 11111111-2222-3333-4444-555555555555 -o abcd --yes',
  )
  .action(async (opts, ref) => {
    await runWorkflowsDelete({
      ref,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const workflowsRun = new Command()
  .description('Trigger a manual workflow run and wait for it to finish.')
  .type('by', byType)
  .type('runMode', runModeType)
  .type('respondAs', respondAsType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force lookup mode (id | suid | name). Default: auto-detect.')
  .option('--input <json:string>', 'Initial input JSON (object).')
  .option('--input-file <path:string>', 'Read initial input JSON from a file.')
  .option('--input-stdin', 'Read initial input JSON from stdin.', { default: false })
  .option('--env <name:string>', 'Override the workflow environment used for variable resolution.')
  .option(
    '--mode <m:runMode>',
    'sync (default: wait for the run to finish) or async (return the executionId immediately).',
    {
      default: 'sync' as const,
    },
  )
  .option(
    '--respond-as <r:respondAs>',
    'Deprecated: use --show <step-id> to print specific step outputs.',
    { default: 'webhook' as const },
  )
  .option(
    '--show <ids:string>',
    'Comma-separated step IDs whose outputs to print after completion ("*" for all).',
    {
      collect: true,
    },
  )
  .option(
    '--hide <ids:string>',
    'Comma-separated step IDs to exclude from --show output.',
    {
      collect: true,
    },
  )
  .option('--timeout <seconds:number>', 'Max seconds to wait for completion (default: no limit).')
  .option(
    '--save-trace <path:string>',
    'After the run completes, save the full trace JSON to this path.',
  )
  .option(
    '--save-steps-to <dir:string>',
    'After the run completes, write one JSON file per step output into this directory.',
  )
  .option('--show-secrets', 'Include secret values in saved trace / step output.', {
    default: false,
  })
  .option('-j, --json', 'Emit the raw API response instead of the human table.', { default: false })
  .example(
    'Run a workflow with input',
    `quickflo workflows run my-wf --input '{"x":1}' -o abcd`,
  )
  .example(
    'Run async (queue + executionId)',
    `quickflo workflows run my-wf --input '{}' --mode async -o abcd`,
  )
  .example(
    'Print every step output after completion',
    `quickflo workflows run my-wf --show '*'`,
  )
  .example(
    'Run + persist trace and per-step outputs',
    `quickflo workflows run my-wf --input '{}' --save-trace ./trace.json --save-steps-to ./steps/`,
  )
  .action(async (opts, ref) => {
    await runWorkflowsRun({
      ref,
      by: opts.by,
      input: opts.input,
      inputFile: opts.inputFile,
      inputStdin: opts.inputStdin,
      env: opts.env,
      mode: opts.mode,
      respondAs: opts.respondAs,
      show: opts.show?.flatMap((s: string) => s.split(',')),
      hide: opts.hide?.flatMap((s: string) => s.split(',')),
      timeout: opts.timeout,
      saveTrace: opts.saveTrace,
      saveStepsTo: opts.saveStepsTo,
      showSecrets: opts.showSecrets,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutionsList = new Command()
  .description('List executions. Default order startedAt:DESC, limit 25.')
  .type('by', byType)
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--workflow <ref:string>', 'Filter to one workflow (UUID, SUID, or name).')
  .option('--by <kind:by>', 'Force lookup mode for --workflow.')
  .option('--status <s:string>', 'Filter by status (running | success | failed | cancelled).')
  .option(
    '--since <duration:string>',
    'Only executions started within the last <duration> (e.g. 30m, 2h, 1d).',
  )
  .option('--where <expr:string>', 'Repeatable <field>:<op>:<value> filter (top-level columns).', {
    collect: true,
  })
  .option(
    '--attr <expr:string>',
    'Repeatable filter on an indexed search attribute: <path>:<op>:<value> ' +
      '(op = eq|ne|contains|ncontains; <path>:<value> defaults to eq). ' +
      'e.g. return.webhookResponse.body.operation:eq:DELETE. ' +
      'Use * as the path to search ALL attributes (*:DELETE, *:ncontains:spam).',
    { collect: true },
  )
  .option(
    '--attr-contains <term:string>',
    'Match executions whose indexed attributes contain <term> in any value (same as --attr "*:<term>").',
  )
  .option(
    '--attr-not-contains <term:string>',
    'Match executions whose indexed attributes do NOT contain <term> in any value.',
  )
  .option('--raw-query <qs:string>', 'Verbatim URLSearchParams appended to the request.')
  .option('--order <field:string>', 'Sort key (e.g. startedAt:DESC).')
  .option('--limit <n:number>', 'Page size (default 25).')
  .option('--all', 'Paginate through every page until empty.', { default: false })
  .option('-j, --json', 'Emit JSON instead of a table.', { default: false })
  .example(
    'Filter by a return attribute',
    "quickflo workflows executions list --attr 'return.webhookResponse.body.operation:eq:DELETE' --since 1d",
  )
  .example(
    'Match any attribute value',
    "quickflo workflows executions list --attr-contains 'DELETE' -j",
  )
  .action(async (opts) => {
    await runWorkflowsExecutionsList({
      workflow: opts.workflow,
      by: opts.by,
      status: opts.status,
      since: opts.since,
      where: opts.where,
      attr: opts.attr,
      attrContains: opts.attrContains,
      attrNotContains: opts.attrNotContains,
      rawQuery: opts.rawQuery,
      order: opts.order,
      limit: opts.limit,
      all: opts.all,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutionsGet = new Command()
  .description('Show one execution with step paths.')
  .arguments('<id:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-j, --json', 'Emit JSON instead of a human view.', { default: false })
  .action(async (opts, id) => {
    await runWorkflowsExecutionsGet({
      id,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutionsLogs = new Command()
  .description('Fetch a single step output (or the full trace with --full).')
  .arguments('<id:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--step <stepId:string>', 'Step ID to fetch output for.')
  .option('--step-path <jsonPath:string>', 'Optional path inside the step output.')
  .option('--full', 'Fetch the full trace data instead of one step.', { default: false })
  .option('--show-secrets', 'Include secret values in the output.', { default: false })
  .action(async (opts, id) => {
    await runWorkflowsExecutionsLogs({
      id,
      step: opts.step,
      stepPath: opts.stepPath,
      full: opts.full,
      showSecrets: opts.showSecrets,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const workflowsExecutionsDownload = new Command()
  .description('Save the full trace JSON to a file.')
  .arguments('<id:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--out <path:string>', 'Output path (default: trace-<id>-<YYYYMMDD-HHmm>.json).')
  .option('--show-secrets', 'Include secret values in the output.', { default: false })
  .action(async (opts, id) => {
    await runWorkflowsExecutionsDownload({
      id,
      out: opts.out,
      showSecrets: opts.showSecrets,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const workflowsExecutionsReplay = new Command()
  .description('Re-run a workflow with the same initial input as the original execution.')
  .type('runMode', runModeType)
  .arguments('<id:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--mode <m:runMode>', 'Execution mode.', { default: 'sync' as const })
  .option('--env <name:string>', 'Override the workflow environment used for variable resolution.')
  .option('--timeout <seconds:number>', 'Client-side timeout (sync mode only).')
  .option('--show <ids:string>', 'Comma-separated step IDs to include in the per-step output.', {
    collect: true,
  })
  .option('--hide <ids:string>', 'Comma-separated step IDs to exclude from the per-step output.', {
    collect: true,
  })
  .option('-j, --json', 'Emit JSON instead of a human view.', { default: false })
  .action(async (opts, id) => {
    await runWorkflowsExecutionsReplay({
      id,
      mode: opts.mode,
      env: opts.env,
      timeout: opts.timeout,
      show: opts.show?.flatMap((s: string) => s.split(',')),
      hide: opts.hide?.flatMap((s: string) => s.split(',')),
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutionsTail = new Command()
  .description(
    'Poll an execution until it reaches a terminal state (success / failed / cancelled). ' +
      'Optional --save-trace and --save-steps-to persist the trace on completion.',
  )
  .arguments('<id:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--interval <seconds:number>', 'Poll interval in seconds (default 2).')
  .option('--timeout <seconds:number>', 'Client-side cutoff. Exits 124 if exceeded.')
  .option('--save-trace <path:string>', 'On completion, save the full trace JSON to this path.')
  .option(
    '--save-steps-to <dir:string>',
    'On completion, write one JSON file per step into this directory.',
  )
  .option('--show-secrets', 'Include secret values in saved trace / step output.', {
    default: false,
  })
  .option(
    '-j, --json',
    'Emit one JSON line per poll, then the final trace JSON at the end.',
    { default: false },
  )
  .action(async (opts, id) => {
    await runWorkflowsExecutionsTail({
      id,
      interval: opts.interval,
      timeout: opts.timeout,
      saveTrace: opts.saveTrace,
      saveStepsTo: opts.saveStepsTo,
      showSecrets: opts.showSecrets,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutionsCancel = new Command()
  .description(
    'Cancel one or more in-flight executions. Non-running rows are silently skipped — ' +
      'the printed count is the server-honest "what actually transitioned".',
  )
  .type('by', byType)
  .arguments('[...ids:string]')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--workflow <ref:string>', 'Filter mode: cancel all running in this workflow.')
  .option('--by <kind:by>', 'Force --workflow lookup mode (id | suid | name).')
  .option('--status <s:string>', 'Filter mode: status equality (typically `running`).')
  .option('--since <duration:string>', 'Filter mode: started within last <duration> (30m, 2h, 1d).')
  .option('--where <expr:string>', 'Filter mode: repeatable <field>:<op>:<value>.', {
    collect: true,
  })
  .option('--limit <n:number>', 'Cap the number of matches resolved by filter mode.')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .option('-j, --json', 'Emit JSON {cancelled, requested} instead of human output.', {
    default: false,
  })
  .example('Cancel one', 'quickflo workflows executions cancel <id> -o abcd')
  .example('Cancel many', 'quickflo workflows executions cancel <id1> <id2> <id3> -o abcd')
  .example(
    'Cancel all running for a workflow',
    'quickflo workflows executions cancel --workflow my-wf --status running -o abcd',
  )
  .action(async (opts, ...ids) => {
    await runWorkflowsExecutionsCancel({
      ids,
      workflow: opts.workflow,
      by: opts.by,
      status: opts.status,
      since: opts.since,
      where: opts.where,
      limit: opts.limit,
      yes: opts.yes,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutionsDelete = new Command()
  .description(
    'Delete one or more execution traces. Running rows are auto-cancelled by the server ' +
      'as part of delete — no need to cancel first. Restorable within the retention window via `restore`.',
  )
  .type('by', byType)
  .arguments('[...ids:string]')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--workflow <ref:string>', 'Filter mode: scope to one workflow.')
  .option('--by <kind:by>', 'Force --workflow lookup mode (id | suid | name).')
  .option('--status <s:string>', 'Filter mode: status equality.')
  .option(
    '--since <duration:string>',
    'Filter mode: only executions started within the last <duration>.',
  )
  .option('--where <expr:string>', 'Filter mode: repeatable <field>:<op>:<value>.', {
    collect: true,
  })
  .option('--limit <n:number>', 'Cap the number of matches resolved by filter mode.')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .option('-j, --json', 'Emit JSON {archived, requested} instead of human output.', {
    default: false,
  })
  .example('Delete one', 'quickflo workflows executions delete <id> -o abcd')
  .example('Delete many', 'quickflo workflows executions delete <id1> <id2> -o abcd')
  .example(
    'Delete all failed in the last day',
    'quickflo workflows executions delete --status failed --since 1d -o abcd',
  )
  .action(async (opts, ...ids) => {
    await runWorkflowsExecutionsDelete({
      ids,
      workflow: opts.workflow,
      by: opts.by,
      status: opts.status,
      since: opts.since,
      where: opts.where,
      limit: opts.limit,
      yes: opts.yes,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutionsRestore = new Command()
  .description(
    'Restore previously deleted executions. Only effective while the row is still in the ' +
      'soft-archive window — past EXECUTION_TRACE_RETENTION_DAYS the IDs are hard-deleted and the count returns 0.',
  )
  .arguments('<...ids:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-j, --json', 'Emit JSON {unarchived, requested} instead of human output.', {
    default: false,
  })
  .example('Restore', 'quickflo workflows executions restore <id1> <id2> -o abcd')
  .action(async (opts, ...ids) => {
    await runWorkflowsExecutionsRestore({
      ids,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsExecutions = new Command()
  .description('Inspect, tail, download, replay, cancel, and delete workflow executions.')
  .command('list', workflowsExecutionsList)
  .command('get', workflowsExecutionsGet)
  .command('logs', workflowsExecutionsLogs)
  .command('download', workflowsExecutionsDownload)
  .command('replay', workflowsExecutionsReplay)
  .command('tail', workflowsExecutionsTail)
  .command('cancel', workflowsExecutionsCancel)
  .command('delete', workflowsExecutionsDelete)
  .command('restore', workflowsExecutionsRestore);

const workflowsValidate = new Command()
  .alias('check')
  .description(
    'Validate a workflow definition against the server without saving or running it.',
  )
  .arguments('[file:string]')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--from-stdin', 'Read the definition JSON from stdin instead of a file.', {
    default: false,
  })
  .option(
    '--strict',
    'Treat warnings (e.g. missing connections) as failures (non-zero exit).',
    {
      default: false,
    },
  )
  .option('-j, --json', 'Emit the { ok, errors, warnings } result as JSON.', {
    default: false,
  })
  .example('Validate a file', 'quickflo workflows validate ./my-wf.json -o abcd')
  .example('Alias', 'quickflo workflows check ./my-wf.json -o abcd')
  .example('Pipe from stdin', 'cat ./my-wf.json | quickflo workflows validate --from-stdin -o abcd')
  .example(
    'Strict + JSON (agent loop)',
    'quickflo workflows validate ./my-wf.json --strict -j -o abcd',
  )
  .action(async (opts, file) => {
    await runWorkflowsValidate({
      source: file,
      fromStdin: opts.fromStdin,
      strict: opts.strict,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsStepsList = new Command()
  .description('List every step type available to workflows.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-j, --json', 'Emit JSON instead of a table.', { default: false })
  .action(async (opts) => {
    await runWorkflowsStepsList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsStepsGet = new Command()
  .description('Show one step type, including its input/output JSON Schemas.')
  .arguments('<type:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-j, --json', 'Emit JSON instead of a human view.', { default: false })
  .action(async (opts, type) => {
    await runWorkflowsStepsGet({
      type,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const workflowsSteps = new Command()
  .description('Discover available step types (catalog with input/output schemas).')
  .command('list', workflowsStepsList)
  .command('get', workflowsStepsGet);

const workflows = new Command()
  .description('Workflow management commands.')
  .command('list', workflowsList)
  .command('get', workflowsGet)
  .command('delete', workflowsDelete)
  .command('push', workflowsPush)
  .command('pull', workflowsPull)
  .command('run', workflowsRun)
  .command('executions', workflowsExecutions)
  .command('validate', workflowsValidate)
  .command('steps', workflowsSteps);

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

const packagesListVersions = new Command()
  .description('List every published version of a package.')
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--where <expr:string>', 'Filter expression <field>:<op>:<value>. Repeatable.', {
    collect: true,
  })
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]', {
    default: 'createdAt:DESC',
  })
  .option('--limit <n:number>', 'Max results (default 50)')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('-j, --json', 'Emit JSON instead of a table', { default: false })
  .option('--all', 'Paginate through every result', { default: false })
  .example('List versions', 'quickflo packages list-versions @acme/onboarding -o myorg')
  .action(async (opts, ref) => {
    await runPackagesListVersions({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      rawQuery: opts.rawQuery,
      json: opts.json,
      all: opts.all,
    });
  });

const packagesUninstall = new Command()
  .description(
    'Uninstall a package install. Deletes every resource the install created.',
  )
  .arguments('<install-id:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .option('-j, --json', 'Emit the uninstall summary as JSON', { default: false })
  .example('Uninstall', 'quickflo packages uninstall <install-id> -o myorg')
  .action(async (opts, installId) => {
    await runPackagesUninstall({
      installId,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
      json: opts.json,
    });
  });

const packagesUpgrade = new Command()
  .description(
    'Preview a reinstall to a new version (and commit it with --apply). Two-step like terraform plan/apply.',
  )
  .arguments('<install-id:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--to <version:string>', 'Target version (semver)', { required: true })
  .option('--apply', 'Commit the upgrade (default: preview only)', { default: false })
  .option(
    '--decisions <file:file>',
    'Override default decisions with a JSON file matching CommitDecisions shape',
  )
  .option('-j, --json', 'Emit the preview/commit result as JSON', { default: false })
  .example('Preview', 'quickflo packages upgrade <install-id> --to 1.2.0 -o myorg')
  .example('Commit', 'quickflo packages upgrade <install-id> --to 1.2.0 --apply -o myorg')
  .action(async (opts, installId) => {
    await runPackagesUpgrade({
      installId,
      to: opts.to,
      apply: opts.apply,
      decisionsFile: opts.decisions,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const packagesInit = new Command()
  .description(
    'Scaffold a pkg.json descriptor for packages publish. Interactive by default; pass every flag to skip prompts.',
  )
  .option('--out <path:string>', 'Where to write the descriptor', { default: 'pkg.json' })
  .option('--name <text:string>', 'Package name (e.g. onboarding)')
  .option('--version <semver:string>', 'Initial version (default 0.1.0)')
  .option('--summary <text:string>', 'One-line summary')
  .option('--visibility <kind:string>', 'public | unlisted | private (default private)')
  .option('--roots <name:string>', 'Root workflow name (repeatable)', { collect: true })
  .option('--from-org <suid:string>', 'Source org to resolve workflow names against')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--yes', 'Skip prompts (every required field must be passed as a flag)', {
    default: false,
  })
  .example('Interactive', 'quickflo packages init')
  .example(
    'Non-interactive',
    'quickflo packages init --name onboarding --roots "Welcome flow" --yes -o myorg',
  )
  .action(async (opts) => {
    await runPackagesInit({
      out: opts.out,
      name: opts.name,
      version: opts.version,
      summary: opts.summary,
      visibility: opts.visibility,
      roots: opts.roots,
      fromOrg: opts.fromOrg,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const packages = new Command()
  .description(
    'Package management commands (export/import composable solution bundles).',
  )
  .command('list', packagesList)
  .command('list-versions', packagesListVersions)
  .command('install', packagesInstall)
  .command('uninstall', packagesUninstall)
  .command('upgrade', packagesUpgrade)
  .command('download', packagesDownload)
  .command('publish', packagesPublish)
  .command('init', packagesInit);

// ─── Micro-apps ──────────────────────────────────────────────────────────────

const microappNew = new Command()
  .description(
    'Scaffold a Vite + TS micro-app pre-wired to @quickflo/app-sdk (auth + onboarding + entitlement + triggers).',
  )
  .arguments('<name:string>')
  .option('--dir <path:string>', 'Parent directory to create the app in', { default: '.' })
  .option('--app-id <sku:string>', 'App SKU bound into the SDK (defaults to <name>)')
  .option('--auth <mode:string>', 'Identity wiring: supabase | none', { default: 'supabase' })
  .option('--framework <kind:string>', 'Project framework (only vite-ts for now)', {
    default: 'vite-ts',
  })
  .option(
    '--free-tier',
    'Emit anonymous free-demo helpers (requires --auth supabase + anonymous sign-ins enabled in the QF Supabase project)',
    { default: false },
  )
  .example('Default (Supabase identity)', 'quickflo microapp new my-app')
  .example('Custom SKU', 'quickflo microapp new my-app --app-id acme-portal')
  .example('Embedded / non-Supabase', 'quickflo microapp new my-app --auth none')
  .example('With an anonymous free demo', 'quickflo microapp new my-app --free-tier')
  .action(async (opts, name) => {
    await runMicroappNew({
      name,
      dir: opts.dir,
      appId: opts.appId,
      auth: opts.auth,
      framework: opts.framework,
      freeTier: opts.freeTier,
    });
  });

const microappStripeSync = new Command()
  .description(
    'Provision a micro-app Stripe product + prices from stripe.config.json (idempotent), writing the ids back into stripe.ids.json + the apps.config snippet.',
  )
  .arguments('[config:string]')
  .option('--config <path:string>', 'Path to stripe.config.json (default ./stripe.config.json)')
  .option('--key <sk:string>', 'Stripe secret key (or set STRIPE_API_KEY / STRIPE_SECRET_KEY)')
  .option('--live', 'Target Stripe live mode (required with an sk_live key)', { default: false })
  .option('--yes', 'Skip the live-mode confirmation prompt (for CI)', { default: false })
  .option('--dry-run', 'Print the intended objects without calling Stripe', { default: false })
  .example('Test mode', 'STRIPE_API_KEY=sk_test_… quickflo microapp stripe-sync')
  .example('Custom path', 'quickflo microapp stripe-sync --config ./config/stripe.config.json')
  .example('Dry run', 'quickflo microapp stripe-sync --dry-run')
  .example('Live mode', 'quickflo microapp stripe-sync --key sk_live_… --live')
  .action(async (opts, config) => {
    await runMicroappStripeSync({
      config: opts.config ?? config,
      key: opts.key,
      live: opts.live,
      yes: opts.yes,
      dryRun: opts.dryRun,
    });
  });

const microapp = new Command()
  .description('Scaffold QuickFlo micro-apps (custom UIs on QuickFlo auth + backend).')
  .command('new', microappNew)
  .command('stripe-sync', microappStripeSync);

// ─── Connections ─────────────────────────────────────────────────────────────

const connectionsList = new Command()
  .description("Print the org's connections as a table (or JSON).")
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '-n, --name <substr:string>',
    'Substring match on name (shorthand for --where name:re:<substr>)',
  )
  .option('--where <expr:string>', 'Filter expression <field>:<op>:<value>. Repeatable.', {
    collect: true,
  })
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]', {
    default: 'updatedAt:DESC',
  })
  .option('--limit <n:number>', 'Max results (default 50)')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('-j, --json', 'Emit JSON instead of a table', { default: false })
  .option('--all', 'Paginate through every result', { default: false })
  .action(async (opts) => {
    await runConnectionsList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      name: opts.name,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      rawQuery: opts.rawQuery,
      json: opts.json,
      all: opts.all,
    });
  });

const connectionsGet = new Command()
  .description('Print one connection as pushable JSON (auto-detects UUID / name).')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force lookup mode (id | suid | name). Default: auto-detect.')
  .option('--mask', 'Replace config values with "***" placeholders', { default: false })
  .option('-j, --json', 'Emit the raw API record instead of pushable shape', { default: false })
  .action(async (opts, ref) => {
    await runConnectionsGet({
      ref,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      mask: opts.mask,
      json: opts.json,
    });
  });

const connectionsPull = new Command()
  .description('Download connections to a local directory as pushable JSON files.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Destination directory', { default: './connections' })
  .option('-n, --name <substr:string>', 'Substring match on name')
  .option('--where <expr:string>', 'Filter expression <field>:<op>:<value>. Repeatable.', {
    collect: true,
  })
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]')
  .option('--limit <n:number>', 'Max results')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('--force', 'Overwrite local files that differ from remote', { default: false })
  .option('--dry-run', 'Print the plan without writing any files', { default: false })
  .option('--mask', 'Write "***" placeholders instead of plaintext secrets', { default: false })
  .action(async (opts) => {
    await runConnectionsPull({
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
      mask: opts.mask,
    });
  });

const connectionsPush = new Command()
  .description('Bulk upsert connection JSON files from a directory.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Source directory', { default: './connections' })
  .option('--dry-run', 'Print the plan without making any changes', { default: false })
  .action(async (opts) => {
    await runConnectionsPush({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      dryRun: opts.dryRun,
    });
  });

const connectionsCreate = new Command()
  .description(
    'Create a connection. For OAuth-typed providers, opens the browser for consent and polls until the connection materializes.',
  )
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--type <text:string>', 'Connection type (run `connections types` to list)', {
    required: true,
  })
  .option('--name <text:string>', 'Connection name (unique per org)', { required: true })
  .option('--config <json:string>', 'Inline JSON config (API-key types only)')
  .option('--from-file <path:file>', 'Read config JSON from a file (API-key types only)')
  .example(
    'API-key',
    'quickflo connections create --type stripe --name billing --config \'{"apiKey":"sk_…"}\' -o myorg',
  )
  .example(
    'OAuth (browser handoff)',
    'quickflo connections create --type slack --name prod-alerts -o myorg',
  )
  .action(async (opts) => {
    await runConnectionsCreate({
      type: opts.type,
      name: opts.name,
      config: opts.config,
      fromFile: opts.fromFile,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const connectionsUpdate = new Command()
  .description('Update a connection (rename or swap config for API-key types).')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force lookup mode (id | name)')
  .option('--name <text:string>', 'Rename')
  .option('--config <json:string>', 'New inline JSON config (API-key types only)')
  .option('--from-file <path:file>', 'Read new config JSON from a file')
  .action(async (opts, ref) => {
    await runConnectionsUpdate({
      ref,
      by: opts.by,
      name: opts.name,
      config: opts.config,
      fromFile: opts.fromFile,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const connectionsDelete = new Command()
  .description('Delete a connection by UUID or name.')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force lookup mode (id | name)')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .action(async (opts, ref) => {
    await runConnectionsDelete({
      ref,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const connectionsTypesList = new Command()
  .description('List registered connection types.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts) => {
    await runConnectionsTypesList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const connectionsTypesSchema = new Command()
  .description('Print the JSON Schema for a connection type.')
  .arguments('<type:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .action(async (opts, type) => {
    await runConnectionsTypesSchema({
      type,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const connectionsTypes = new Command()
  .description('Inspect registered connection types.')
  .command('list', connectionsTypesList)
  .command('schema', connectionsTypesSchema);

const connectionsTest = new Command()
  .description(
    'Verify a connection by hitting POST /connections/:id/test. The endpoint is not yet shipped on every server — the command surfaces a clear "not implemented" error in that case.',
  )
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-j, --json', 'Emit the raw API response (if successful).', { default: false })
  .action(async (opts, ref) => {
    await runConnectionsTest({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const connections = new Command()
  .description('Manage saved credentials for external services.')
  .command('list', connectionsList)
  .command('get', connectionsGet)
  .command('create', connectionsCreate)
  .command('update', connectionsUpdate)
  .command('pull', connectionsPull)
  .command('push', connectionsPush)
  .command('delete', connectionsDelete)
  .command('test', connectionsTest)
  .command('types', connectionsTypes);

// ─── Environments ────────────────────────────────────────────────────────────

const environmentsList = new Command()
  .description("Print the org's environments as a table (or JSON).")
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-n, --name <substr:string>', 'Substring match on name')
  .option('--where <expr:string>', 'Filter expression <field>:<op>:<value>. Repeatable.', {
    collect: true,
  })
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]', {
    default: 'updatedAt:DESC',
  })
  .option('--limit <n:number>', 'Max results (default 50)')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('-j, --json', 'Emit JSON instead of a table', { default: false })
  .option('--all', 'Paginate through every result', { default: false })
  .action(async (opts) => {
    await runEnvironmentsList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      name: opts.name,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      rawQuery: opts.rawQuery,
      json: opts.json,
      all: opts.all,
    });
  });

const environmentsGet = new Command()
  .description('Print one environment as pushable JSON.')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force lookup mode (id | name)')
  .option('--mask', 'Replace values with "***"', { default: false })
  .option('-j, --json', 'Emit the raw API record', { default: false })
  .action(async (opts, ref) => {
    await runEnvironmentsGet({
      ref,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      mask: opts.mask,
      json: opts.json,
    });
  });

const environmentsPull = new Command()
  .description('Download environments to a local directory.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Destination directory', { default: './environments' })
  .option('-n, --name <substr:string>', 'Substring match on name')
  .option('--where <expr:string>', 'Filter expression <field>:<op>:<value>. Repeatable.', {
    collect: true,
  })
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]')
  .option('--limit <n:number>', 'Max results')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('--force', 'Overwrite local files that differ from remote', { default: false })
  .option('--dry-run', 'Print the plan without writing any files', { default: false })
  .option('--mask', 'Write "***" placeholders instead of plaintext values', { default: false })
  .action(async (opts) => {
    await runEnvironmentsPull({
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
      mask: opts.mask,
    });
  });

const environmentsPush = new Command()
  .description('Bulk upsert environments + variables from a directory.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Source directory', { default: './environments' })
  .option('--dry-run', 'Print the plan without making any changes', { default: false })
  .option('--prune', 'Delete remote vars not present in the file (bulk-delete)', {
    default: false,
  })
  .action(async (opts) => {
    await runEnvironmentsPush({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      dryRun: opts.dryRun,
      prune: opts.prune,
    });
  });

const environmentsCreate = new Command()
  .description('Create an environment, optionally seeded with --var KEY=VALUE pairs.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--name <text:string>', 'Environment name (unique per org)', { required: true })
  .option('--var <expr:string>', 'KEY=VALUE pair (repeatable)', { collect: true })
  .example('Empty env', 'quickflo environments create --name staging -o myorg')
  .example(
    'Seeded',
    'quickflo environments create --name prod --var DATABASE_URL=postgres://… --var REDIS_URL=redis://… -o myorg',
  )
  .action(async (opts) => {
    await runEnvironmentsCreate({
      name: opts.name,
      vars: opts.var,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const environmentsUpdate = new Command()
  .description('Rename an environment. (Variable edits go through set/unset/push.)')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force lookup mode (id | name)')
  .option('--name <text:string>', 'New name', { required: true })
  .action(async (opts, ref) => {
    await runEnvironmentsUpdate({
      ref,
      by: opts.by,
      name: opts.name,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const environmentsSet = new Command()
  .description('Set a single variable on an environment.')
  .type('by', byType)
  .arguments('<env:string> <key:string> <value:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force env lookup mode (id | name)')
  .action(async (opts, env, key, value) => {
    await runEnvironmentsVarSet({
      ref: env,
      key,
      value,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const environmentsUnset = new Command()
  .description('Delete a single variable from an environment.')
  .type('by', byType)
  .arguments('<env:string> <key:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force env lookup mode (id | name)')
  .action(async (opts, env, key) => {
    await runEnvironmentsVarUnset({
      ref: env,
      key,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const environmentsVars = new Command()
  .description("Print one environment's variables.")
  .type('by', byType)
  .arguments('<env:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force env lookup mode (id | name)')
  .option('--mask', 'Show keys only (no values fetched server-side)', { default: false })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, env) => {
    await runEnvironmentsVars({
      ref: env,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      mask: opts.mask,
      json: opts.json,
    });
  });

const environmentsDelete = new Command()
  .description('Delete an environment.')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--by <kind:by>', 'Force lookup mode (id | name)')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .action(async (opts, ref) => {
    await runEnvironmentsDelete({
      ref,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const environments = new Command()
  .description('Manage environment variable sets.')
  .command('list', environmentsList)
  .command('get', environmentsGet)
  .command('create', environmentsCreate)
  .command('update', environmentsUpdate)
  .command('pull', environmentsPull)
  .command('push', environmentsPush)
  .command('set', environmentsSet)
  .command('unset', environmentsUnset)
  .command('vars', environmentsVars)
  .command('delete', environmentsDelete);

// ─── Triggers ────────────────────────────────────────────────────────────────

const triggerTypeType = new EnumType(['webhook', 'schedule', 'event', 'form']);

const triggersList = new Command()
  .description('List triggers. Org-wide by default; --workflow scopes to one workflow.')
  .type('by', byType)
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope to one workflow (UUID, SUID, or name)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .option('--where <expr:string>', 'Filter expression <field>:<op>:<value>. Repeatable.', {
    collect: true,
  })
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]', {
    default: 'updatedAt:DESC',
  })
  .option('--limit <n:number>', 'Max results')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts) => {
    await runTriggersList({
      workflow: opts.workflow,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      json: opts.json,
    });
  });

const triggersGet = new Command()
  .description('Get one trigger by UUID or name (includes computed URLs).')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope name lookup to one workflow (disambiguator)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .action(async (opts, ref) => {
    await runTriggersGet({
      ref,
      workflow: opts.workflow,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const triggersCreate = new Command()
  .description('Create a trigger on a workflow (the one verb that needs --workflow).')
  .type('by', byType)
  .type('triggerType', triggerTypeType)
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Target workflow (UUID, SUID, or name)', {
    required: true,
  })
  .option('--by <kind:by>', 'Force workflow lookup mode')
  .option('--type <kind:triggerType>', 'Trigger type (required unless --from-file)')
  .option('--name <text:string>', 'Trigger name')
  .option('--from-file <path:file>', 'JSON body for the trigger config')
  .option(
    '--secret <token:string>',
    'Shared webhook secret (token auth). Omit to auto-generate; reuse the same value to share a token across endpoints.',
  )
  .action(async (opts) => {
    await runTriggersCreate({
      workflow: opts.workflow,
      type: opts.type,
      name: opts.name,
      fromFile: opts.fromFile,
      secret: opts.secret,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const triggersUpdate = new Command()
  .description('Update a trigger (name, enabled, config) by UUID or name.')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope name lookup to one workflow (disambiguator)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .option('--name <text:string>', 'New name')
  .option('--enabled <bool:string>', 'true | false')
  .option('--from-file <path:file>', 'JSON body to merge (typically the `config` block)')
  .option(
    '--secret <token:string>',
    'Set the shared webhook secret (token auth). Reuse the same value to share a token across endpoints.',
  )
  .action(async (opts, ref) => {
    await runTriggersUpdate({
      ref,
      workflow: opts.workflow,
      by: opts.by,
      name: opts.name,
      enabled: opts.enabled,
      fromFile: opts.fromFile,
      secret: opts.secret,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const triggersDelete = new Command()
  .description('Delete a trigger by UUID or name.')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope name lookup to one workflow (disambiguator)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .action(async (opts, ref) => {
    await runTriggersDelete({
      ref,
      workflow: opts.workflow,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const triggersEnable = new Command()
  .description('Enable a trigger by UUID or name (resumes schedule triggers).')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope name lookup to one workflow (disambiguator)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .action(async (opts, ref) => {
    await runTriggersEnable({
      ref,
      workflow: opts.workflow,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const triggersDisable = new Command()
  .description('Disable a trigger by UUID or name (pauses schedule triggers).')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope name lookup to one workflow (disambiguator)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .action(async (opts, ref) => {
    await runTriggersDisable({
      ref,
      workflow: opts.workflow,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const triggersRotateSecret = new Command()
  .description(
    "Rotate a webhook trigger's secret by UUID or name. The new secret is printed once.",
  )
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope name lookup to one workflow (disambiguator)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .action(async (opts, ref) => {
    await runTriggersRotateSecret({
      ref,
      workflow: opts.workflow,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const triggersDuplicate = new Command()
  .description('Duplicate a trigger (by UUID or name) to another workflow.')
  .type('by', byType)
  .arguments('<ref:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-w, --workflow <ref:string>', 'Scope name lookup to one workflow (disambiguator)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .option('--to <workflow:string>', 'Target workflow ref', { required: true })
  .option('--name <text:string>', 'Name for the duplicated trigger')
  .action(async (opts, ref) => {
    await runTriggersDuplicate({
      ref,
      workflow: opts.workflow,
      to: opts.to,
      name: opts.name,
      by: opts.by,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const triggersPull = new Command()
  .description(
    'Download triggers to a local directory. Each file links its workflow by name (round-trips with `triggers push`).',
  )
  .type('by', byType)
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Destination directory for JSON files', {
    default: './triggers',
  })
  .option('-w, --workflow <ref:string>', 'Scope to one workflow (UUID, SUID, or name)')
  .option('--by <kind:by>', 'Force workflow lookup mode (only with --workflow)')
  .option(
    '-n, --name <substr:string>',
    'Substring match on trigger name (shorthand for --where name:re:<substr>)',
  )
  .option(
    '--where <expr:string>',
    'Filter expression <field>:<op>:<value>. Repeatable.',
    { collect: true },
  )
  .option('--order <spec:string>', 'Sort order <field>[:ASC|DESC]')
  .option('--limit <n:number>', 'Max results')
  .option('--raw-query <qs:string>', 'Raw URLSearchParams passthrough')
  .option('--force', 'Overwrite local files that differ from remote', { default: false })
  .option('--dry-run', 'Print the plan without writing any files', { default: false })
  .option(
    '--include-packages',
    'Also pull triggers installed from packages (default: org-owned only)',
    { default: false },
  )
  .example('Pull all triggers', 'quickflo triggers pull -d ./triggers -o abcd')
  .example(
    'Pull one workflow’s triggers',
    "quickflo triggers pull -w 'Order Handler' -d ./triggers -o abcd",
  )
  .action(async (opts) => {
    await runTriggersPull({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      workflow: opts.workflow,
      by: opts.by,
      name: opts.name,
      where: opts.where,
      order: opts.order,
      limit: opts.limit,
      rawQuery: opts.rawQuery,
      force: opts.force,
      dryRun: opts.dryRun,
      includePackages: opts.includePackages,
    });
  });

const triggersPush = new Command()
  .description(
    'Bulk upsert triggers from a directory, associating each with its workflow by name. Push workflows first.',
  )
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-d, --dir <path:file>', 'Directory of trigger JSON files', {
    default: './triggers',
  })
  .option('--dry-run', 'Print the plan without making any changes', { default: false })
  .example('Push triggers', 'quickflo triggers push -d ./triggers -o abcd')
  .example('Dry-run', 'quickflo triggers push --dry-run -o abcd')
  .action(async (opts) => {
    await runTriggersPush({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      dryRun: opts.dryRun,
    });
  });

const triggers = new Command()
  .description('Manage workflow triggers (webhooks, schedules, forms, events).')
  .command('list', triggersList)
  .command('pull', triggersPull)
  .command('push', triggersPush)
  .command('get', triggersGet)
  .command('create', triggersCreate)
  .command('update', triggersUpdate)
  .command('delete', triggersDelete)
  .command('enable', triggersEnable)
  .command('disable', triggersDisable)
  .command('rotate-secret', triggersRotateSecret)
  .command('duplicate', triggersDuplicate);

// ─── Data stores ─────────────────────────────────────────────────────────────

const dsTablesList = new Command()
  .description('List data store tables and their key counts.')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-j, --json', 'Emit JSON', { default: false })
  .option('--all', 'Paginate through every table', { default: false })
  .option('--limit <n:number>', 'Max results')
  .action(async (opts) => {
    await runDataStoresTablesList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
      all: opts.all,
      limit: opts.limit,
    });
  });

const dsTablesCreate = new Command()
  .description('Create a new data store table.')
  .arguments('<table:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .action(async (opts, table) => {
    await runDataStoresTablesCreate({
      tableName: table,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const dsTablesDelete = new Command()
  .description('Delete an entire data store table (all entries).')
  .arguments('<table:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .action(async (opts, table) => {
    await runDataStoresTablesDelete({
      tableName: table,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const dsTables = new Command()
  .description('Manage data store tables.')
  .command('list', dsTablesList)
  .command('create', dsTablesCreate)
  .command('delete', dsTablesDelete);

const dsRecordsList = new Command()
  .description('List entries in a data store table.')
  .arguments('<table:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--prefix <s:string>', 'Filter by key prefix')
  .option('--filter <expr:string>', 'JSONB filter: field:value or field:=value. Repeatable.', {
    collect: true,
  })
  .option('--sort <field:string>', 'Sort field: key | createdAt | updatedAt')
  .option('--desc', 'Sort descending', { default: false })
  .option('--limit <n:number>', 'Max results')
  .option('--all', 'Paginate through every entry', { default: false })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, table) => {
    await runDataStoresRecordsList({
      tableName: table,
      prefix: opts.prefix,
      filter: opts.filter,
      sort: opts.sort,
      desc: opts.desc,
      limit: opts.limit,
      all: opts.all,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const dsRecordsGet = new Command()
  .description("Get one entry's value (or the full record with --meta).")
  .arguments('<table:string> <key:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--meta', 'Emit the full record (timestamps, expiry, ids)', { default: false })
  .option('-j, --json', 'Compact JSON on one line, no status banner (pipe-friendly)', {
    default: false,
  })
  .action(async (opts, table, key) => {
    await runDataStoresRecordsGet({
      tableName: table,
      key,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      meta: opts.meta,
      json: opts.json,
    });
  });

const dsRecordsSet = new Command()
  .description('Upsert one entry (PATCH-then-POST-on-404).')
  .arguments('<table:string> <key:string> [value:string]')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--from-stdin', 'Read the value (JSON or raw text) from stdin', { default: false })
  .option('--from-file <path:file>', 'Read the value from a file')
  .option('--ttl <seconds:number>', 'Expire the entry after N seconds')
  .action(async (opts, table, key, value) => {
    await runDataStoresRecordsSet({
      tableName: table,
      key,
      value,
      fromStdin: opts.fromStdin,
      fromFile: opts.fromFile,
      ttl: opts.ttl,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const dsRecordsDelete = new Command()
  .description('Delete one entry.')
  .arguments('<table:string> <key:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--yes', 'Skip the confirmation prompt', { default: false })
  .action(async (opts, table, key) => {
    await runDataStoresRecordsDelete({
      tableName: table,
      key,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const dsImport = new Command()
  .description('Bulk-upsert entries into a table from a JSON file (or stdin).')
  .arguments('<table:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('-f, --file <path:file>', 'Source JSON (array of {key,value} or {key:value} object)')
  .action(async (opts, table) => {
    await runDataStoresImport({
      tableName: table,
      file: opts.file,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const dsExport = new Command()
  .description("Export a table's entries as JSON (default), NDJSON, or CSV.")
  .arguments('<table:string>')
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option('--out <path:string>', 'Write to a file (default: stdout)')
  .option('--format <fmt:string>', 'Output format: json | ndjson | csv', { default: 'json' })
  .option('--prefix <s:string>', 'Only export keys with this prefix')
  .option('--filter <expr:string>', 'JSONB filter: field:value or field:=value. Repeatable.', {
    collect: true,
  })
  .option('--sort <field:string>', 'Sort field: key | createdAt | updatedAt (default: key)')
  .option('--desc', 'Sort descending', { default: false })
  .option('--limit <n:number>', 'Cap how many entries are exported (default: all)')
  .action(async (opts, table) => {
    const format = opts.format.toLowerCase();
    if (format !== 'json' && format !== 'ndjson' && format !== 'csv') {
      console.error(`Invalid --format "${opts.format}" (expected json | ndjson | csv)`);
      Deno.exit(2);
    }
    await runDataStoresExport({
      tableName: table,
      output: opts.out,
      format,
      prefix: opts.prefix,
      filter: opts.filter,
      sort: opts.sort,
      desc: opts.desc,
      limit: opts.limit,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const dataStores = new Command()
  .description('Manage data store tables and records.')
  .command('tables', dsTables)
  .command('list', dsRecordsList)
  .command('get', dsRecordsGet)
  .command('set', dsRecordsSet)
  .command('delete', dsRecordsDelete)
  .command('import', dsImport)
  .command('export', dsExport);

// ─── Dashboards ────────────────────────────────────────────────────────────

const orgOpt = (cmd: Command) =>
  cmd
    .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
    .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)');

const dashboardsList = orgOpt(new Command())
  .description('List dashboards (org-owned by default).')
  .option('-n, --name <substr:string>', 'Substring match on dashboard name')
  .option('--include-packages', 'Include dashboards installed from packages', { default: false })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts) => {
    await runDashboardsList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      name: opts.name,
      includePackages: opts.includePackages,
      json: opts.json,
    });
  });

const dashboardsGet = orgOpt(new Command())
  .description('Get one dashboard (with widgets) by UUID or name.')
  .arguments('<ref:string>')
  .option('--sources', 'Embed referenced data-source definitions', { default: false })
  .action(async (opts, ref) => {
    await runDashboardsGet({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      sources: opts.sources,
    });
  });

const dashboardsCreate = orgOpt(new Command())
  .description('Create a dashboard (metadata only; add widgets via push).')
  .arguments('<name:string>')
  .option('--description <text:string>', 'Dashboard description')
  .option('--timezone <tz:string>', 'IANA timezone (e.g. America/Los_Angeles)')
  .option('--default', 'Make this the org default dashboard', { default: undefined })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, name) => {
    await runDashboardsCreate({
      name,
      description: opts.description,
      timezone: opts.timezone,
      default: opts.default,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const dashboardsUpdate = orgOpt(new Command())
  .description('Update dashboard metadata (name/description/timezone/default).')
  .arguments('<ref:string>')
  .option('--name <name:string>', 'New name')
  .option('--description <text:string>', 'New description')
  .option('--timezone <tz:string>', 'New IANA timezone')
  .option('--default', 'Make this the org default dashboard', { default: undefined })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref) => {
    await runDashboardsUpdate({
      ref,
      name: opts.name,
      description: opts.description,
      timezone: opts.timezone,
      default: opts.default,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const dashboardsDelete = orgOpt(new Command())
  .description('Delete a dashboard and all its widgets by UUID or name.')
  .arguments('<ref:string>')
  .option('-y, --yes', 'Skip confirmation', { default: false })
  .action(async (opts, ref) => {
    await runDashboardsDelete({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const dashboardsPull = orgOpt(new Command())
  .description('Download dashboards to a local dir as native JSON (round-trips with push).')
  .option('-d, --dir <path:file>', 'Destination directory', { default: './dashboards' })
  .option('-n, --name <substr:string>', 'Substring match on dashboard name')
  .option('--include-packages', 'Include package-installed dashboards', { default: false })
  .option('--force', 'Overwrite local files that differ', { default: false })
  .option('--dry-run', 'Print the plan without writing', { default: false })
  .action(async (opts) => {
    await runDashboardsPull({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      name: opts.name,
      includePackages: opts.includePackages,
      force: opts.force,
      dryRun: opts.dryRun,
    });
  });

const dashboardsPush = orgOpt(new Command())
  .description('Upsert dashboards from a directory of native JSON files (same-org round-trip).')
  .option('-d, --dir <path:file>', 'Directory of dashboard JSON files', { default: './dashboards' })
  .option('--create-missing-sources', 'Recreate embedded data sources absent from the org', {
    default: false,
  })
  .option('--dry-run', 'Print the plan without making changes', { default: false })
  .action(async (opts) => {
    await runDashboardsPush({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      createMissingSources: opts.createMissingSources,
      dryRun: opts.dryRun,
    });
  });

const dashboardsExport = orgOpt(new Command())
  .description('Export a dashboard to the portable (cross-org) JSON format.')
  .arguments('<ref:string>')
  .option('--out <path:file>', 'Write to a file instead of stdout')
  .action(async (opts, ref) => {
    await runDashboardsExport({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      out: opts.out,
    });
  });

const dashboardsImport = orgOpt(new Command())
  .description('Import a portable dashboard export into this org (auto-maps sources by name).')
  .option('-f, --file <path:file>', 'Portable export JSON file', { required: true })
  .option('--name <name:string>', 'Override the imported dashboard name')
  .option('--map <pair:string>', 'Map a source: <exportId|name>=<source-ref>. Repeatable.', {
    collect: true,
  })
  .option('--dry-run', 'Resolve mappings without importing', { default: false })
  .option(
    '--no-sync-fields',
    'Skip reconciling calculated fields / window dimensions onto mapped sources',
  )
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts) => {
    await runDashboardsImport({
      file: opts.file,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      name: opts.name,
      map: opts.map,
      dryRun: opts.dryRun,
      syncFields: opts.syncFields,
      json: opts.json,
    });
  });

const dashboardsQuery = orgOpt(new Command())
  .description('Run an analytics query (what a widget runs). Verify data before saving widgets.')
  .option('-f, --file <path:file>', 'Query JSON file (AnalyticsQuery or { query })')
  .option('-s, --source <ref:string>', 'Data source (UUID or name); auto-prefixes bare field names')
  .option('-m, --measure <field:string>', 'Measure field. Repeatable.', { collect: true })
  .option('-d, --dimension <field:string>', 'Dimension field. Repeatable.', { collect: true })
  .option(
    '--filter <expr:string>',
    'Filter field:op[:value] (eq,ne,contains,gt,gte,lt,lte,set,notset). Repeatable.',
    {
      collect: true,
    },
  )
  .option('--time-dimension <field:string>', 'Time dimension field')
  .option('--granularity <g:string>', 'Time granularity (15min,30min,hour,day,week,month,year)')
  .option('--date-range <range:string>', 'Date range (e.g. "last 7 days")')
  .option('--order <spec:string>', 'Order field[:asc|desc], comma-separated')
  .option('--limit <n:number>', 'Row limit')
  .option('--timezone <tz:string>', 'IANA timezone')
  .option('--raw', 'Print the full result (annotation + echo), not just rows', { default: false })
  .action(async (opts) => {
    await runDashboardsQuery({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      file: opts.file,
      source: opts.source,
      measure: opts.measure,
      dimension: opts.dimension,
      filter: opts.filter,
      timeDimension: opts.timeDimension,
      granularity: opts.granularity,
      dateRange: opts.dateRange,
      order: opts.order,
      limit: opts.limit,
      timezone: opts.timezone,
      raw: opts.raw,
    });
  });

const dashboardsMeta = orgOpt(new Command())
  .description('List available measures and dimensions per data source.')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts) => {
    await runDashboardsMeta({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

// Data-source subgroup

const sourcesList = orgOpt(new Command())
  .description('List dashboard data sources.')
  .option('--include-packages', 'Include package-installed sources', { default: false })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts) => {
    await runSourcesList({
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      includePackages: opts.includePackages,
      json: opts.json,
    });
  });

const sourcesGet = orgOpt(new Command())
  .description('Get one data source (UUID or name), full record.')
  .arguments('<ref:string>')
  .action(async (opts, ref) => {
    await runSourcesGet({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const sourcesCreate = orgOpt(new Command())
  .description('Create a data source from a JSON body (createDataSource shape).')
  .option('-f, --file <path:file>', 'Data source JSON file', { required: true })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts) => {
    await runSourcesCreate({
      file: opts.file,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const sourcesUpdate = orgOpt(new Command())
  .description('Update a data source from a JSON body.')
  .arguments('<ref:string>')
  .option('-f, --file <path:file>', 'Data source JSON file', { required: true })
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref) => {
    await runSourcesUpdate({
      ref,
      file: opts.file,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const sourcesDelete = orgOpt(new Command())
  .description('Delete a data source by UUID or name.')
  .arguments('<ref:string>')
  .option('-y, --yes', 'Skip confirmation', { default: false })
  .action(async (opts, ref) => {
    await runSourcesDelete({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      yes: opts.yes,
    });
  });

const sourcesRefresh = orgOpt(new Command())
  .description('Re-sample a data source schema from its underlying table.')
  .arguments('<ref:string>')
  .action(async (opts, ref) => {
    await runSourcesRefresh({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
    });
  });

const sourcesSync = orgOpt(new Command())
  .description("Trigger a data source's sync workflow.")
  .arguments('<ref:string>')
  .option('--start-date <date:string>', 'Sync window start')
  .option('--end-date <date:string>', 'Sync window end')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref) => {
    await runSourcesSync({
      ref,
      startDate: opts.startDate,
      endDate: opts.endDate,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const sourcesDistinct = orgOpt(new Command())
  .description('List distinct values for a dimension (filter options).')
  .arguments('<ref:string> <dimension:string>')
  .option('--search <term:string>', 'Filter values by substring')
  .option('--limit <n:number>', 'Max values')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref, dimension) => {
    await runSourcesDistinct({
      ref,
      dimension,
      search: opts.search,
      limit: opts.limit,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const sourcesFields = orgOpt(new Command())
  .description('List computed fields (calculated fields + window dimensions) on a source.')
  .arguments('<ref:string>')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref) => {
    await runSourceFieldsList({
      ref,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const calcFieldSet = orgOpt(new Command())
  .description('Create or update a calculated field by name (jsep formula; upsert).')
  .arguments('<ref:string>')
  .option(
    '-f, --file <path:file>',
    'Field JSON: {name, label, type, expression, formula?, measure?}',
    {
      required: true,
    },
  )
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref) => {
    await runCalcFieldSet({
      ref,
      file: opts.file,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const calcFieldDelete = orgOpt(new Command())
  .description('Delete a calculated field by name.')
  .arguments('<ref:string> <name:string>')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref, name) => {
    await runCalcFieldDelete({
      ref,
      name,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const sourcesCalcField = new Command()
  .description('Manage calculated fields on a data source (dedicated server routes).')
  .command('set', calcFieldSet)
  .command('delete', calcFieldDelete);

const windowDimSet = orgOpt(new Command())
  .description('Create or update a window dimension by name (row_number rank field; upsert).')
  .arguments('<ref:string>')
  .option(
    '-f, --file <path:file>',
    'Field JSON: {name, label, function: "row_number", partitionBy, orderBy, direction?, semantic?}',
    { required: true },
  )
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref) => {
    await runWindowDimSet({
      ref,
      file: opts.file,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const windowDimDelete = orgOpt(new Command())
  .description('Delete a window dimension by name.')
  .arguments('<ref:string> <name:string>')
  .option('-j, --json', 'Emit JSON', { default: false })
  .action(async (opts, ref, name) => {
    await runWindowDimDelete({
      ref,
      name,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const sourcesWindowDim = new Command()
  .description('Manage window dimensions on a data source (ClickHouse-served sources only).')
  .command('set', windowDimSet)
  .command('delete', windowDimDelete);

const dashboardSources = new Command()
  .description('Manage and introspect dashboard data sources.')
  .command('list', sourcesList)
  .command('get', sourcesGet)
  .command('create', sourcesCreate)
  .command('update', sourcesUpdate)
  .command('delete', sourcesDelete)
  .command('refresh', sourcesRefresh)
  .command('sync', sourcesSync)
  .command('distinct', sourcesDistinct)
  .command('fields', sourcesFields)
  .command('calc-field', sourcesCalcField)
  .command('window-dim', sourcesWindowDim);

const dashboardsCheck = orgOpt(new Command())
  .alias('validate')
  .description(
    "Validate a dashboard file's widgets against the server without saving them.",
  )
  .arguments('[file:string]')
  .option('--from-stdin', 'Read the dashboard JSON from stdin instead of a file.', {
    default: false,
  })
  .option('--strict', 'Treat warnings as failures (non-zero exit).', {
    default: false,
  })
  .option('-j, --json', 'Emit the { ok, errors, warnings } result as JSON.', {
    default: false,
  })
  .example('Check a pulled file', 'quickflo dashboards check ./dashboards/ops.json -o abcd')
  .example('Alias', 'quickflo dashboards validate ./dashboards/ops.json -o abcd')
  .example(
    'Pipe from stdin',
    'cat ./ops.json | quickflo dashboards check --from-stdin -o abcd',
  )
  .example(
    'Strict + JSON (agent loop)',
    'quickflo dashboards check ./ops.json --strict -j -o abcd',
  )
  .action(async (opts, file) => {
    await runDashboardsCheck({
      source: file,
      fromStdin: opts.fromStdin,
      strict: opts.strict,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const dashboards = new Command()
  .description('Manage dashboards, data sources, and analytics queries.')
  .command('list', dashboardsList)
  .command('get', dashboardsGet)
  .command('create', dashboardsCreate)
  .command('update', dashboardsUpdate)
  .command('delete', dashboardsDelete)
  .command('check', dashboardsCheck)
  .command('pull', dashboardsPull)
  .command('push', dashboardsPush)
  .command('export', dashboardsExport)
  .command('import', dashboardsImport)
  .command('query', dashboardsQuery)
  .command('meta', dashboardsMeta)
  .command('sources', dashboardSources);

// ─── Backup ──────────────────────────────────────────────────────────────────

const backup = new Command()
  .description(
    'Pull everything (workflows, connections, environments, triggers, data-stores) into one folder. Defaults to a folder named after the org.',
  )
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '-d, --dir <path:file>',
    'Destination root folder (default: the org name, slugified)',
  )
  .option('--force', 'Overwrite local files that differ from remote', { default: false })
  .option('--dry-run', 'Print the plan without writing any files', { default: false })
  .option('--mask', 'Redact connection/environment secrets as "***"', { default: false })
  .option(
    '--include-packages',
    'Also back up resources installed from packages (default: org-owned only)',
    { default: false },
  )
  .option(
    '--data-store-limit <n:number>',
    'Max records to export per data-store table (default 10000). Set high to capture huge tables.',
    { default: 10000 },
  )
  .example('Back up an org', 'quickflo backup -o acme')
  .example('Back up to a specific folder', 'quickflo backup -d ./snapshots/acme -o acme')
  .example('Preview without writing', 'quickflo backup --dry-run -o acme')
  .example('Capture large data-store tables', 'quickflo backup --data-store-limit 1000000 -o acme')
  .action(async (opts) => {
    await runBackup({
      dir: opts.dir,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      force: opts.force,
      dryRun: opts.dryRun,
      mask: opts.mask,
      includePackages: opts.includePackages,
      dataStoreLimit: opts.dataStoreLimit,
    });
  });

// Surface a JSON error envelope when any command in the tree was given -j/--json.
// Cliffy parses per-command, so the root catch can't see per-command flags
// directly — scan argv to honor the contract at the top-level boundary.
const wantsJsonErrors = Deno.args.some((a) => a === '-j' || a === '--json');
// -j/--json implies --quiet: machine callers want pure payload on stdout and no
// banner chrome on stderr, so they can chain/capture without scrubbing output.
if (wantsJsonErrors || Deno.args.some((a) => a === '--quiet')) setQuiet(true);

const skillInstall = new Command()
  .description(
    'Install the QuickFlo agent skill from the guides embedded in this CLI (no repo or network needed). harness = claude (default) | agents (Codex/AGENTS.md) | mcp (prints host config).',
  )
  .arguments('[harness:string] [target:string]')
  .example('Claude skill (default → ~/.claude/skills/quickflo)', 'quickflo skill install')
  .example('Codex / agents.md', 'quickflo skill install agents ~/.codex/AGENTS.md')
  .example('Print MCP host config', 'quickflo skill install mcp')
  .action(async (_opts, harness, target) => {
    await runSkillInstall({ harness, target });
  });

const skill = new Command()
  .description('Install the QuickFlo agent skill (Claude SKILL.md / Codex AGENTS.md / MCP config).')
  .action(function () {
    this.showHelp();
  })
  .command('install', skillInstall);

const mcp = new Command()
  .description(
    'Run a stdio MCP server exposing workflow tools (list_steps, get_step_schema, list_connections, validate_workflow, save_workflow_draft) to MCP hosts. Auth via the active profile; org via QF_ORG or per-tool arg.',
  )
  .example(
    'Run the MCP server',
    'quickflo mcp   # configure your MCP host to launch this',
  )
  .action(async () => {
    await runMcp();
  });

// Raw cliffy opts for the logs commands. Extracting the shared options into a
// helper erases cliffy's per-flag type inference, so the action casts to this
// known shape (the option names below are the source of truth).
interface RawLogsOpts {
  org?: string;
  apiUrl?: string;
  source?: string[];
  level?: string[];
  channel?: string[];
  provider?: string[];
  origin?: string[];
  tag?: string[];
  workflow?: string;
  execution?: string;
  connection?: string;
  connectionName?: string;
  trigger?: string;
  instance?: string;
  id?: string;
  search?: string[];
  data?: string[];
  since?: string;
  from?: string;
  to?: string;
  limit?: number;
  all?: boolean;
  follow?: boolean;
  interval?: number;
  timeout?: number;
  json?: boolean;
}

// Shared facet/filter flags inlined on each command (cliffy accumulates option
// types through the fluent chain, so they cannot be factored into a helper
// without erasing inference). Repeatable flags also accept comma-separated
// values (`--level warn,error`). Keep the two lists in sync.
const logsSearch = new Command()
  .description(
    'Query the unified log stream (workflow logs, step errors, connection failures, ' +
      'trigger firings, audit). Same facets as the Logs explorer UI. Table to stdout, ' +
      'counts to stderr; -j emits raw entries.',
  )
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '--source <s:string>',
    'Filter by source (workflow|connection|trigger|audit|event-receiver|integration-sync). Repeatable / CSV.',
    { collect: true },
  )
  .option('--level <l:string>', 'Filter by level (debug|info|warn|error). Repeatable / CSV.', {
    collect: true,
  })
  .option('--channel <c:string>', 'Filter by channel. Repeatable / CSV.', { collect: true })
  .option('--provider <p:string>', 'Filter by provider. Repeatable / CSV.', { collect: true })
  .option('--origin <o:string>', 'Filter by origin (core.log|engine). Repeatable / CSV.', {
    collect: true,
  })
  .option(
    '--tag <t:string>',
    'Filter to logs from workflows carrying any of these tags. Repeatable / CSV.',
    {
      collect: true,
    },
  )
  .option('--workflow <id:string>', 'Exact workflowId.')
  .option('--execution <id:string>', 'Exact executionId.')
  .option('--connection <id:string>', 'Exact connectionId.')
  .option('--connection-name <name:string>', 'Exact connection name.')
  .option('--trigger <id:string>', 'Exact triggerId.')
  .option('--instance <id:string>', 'Exact instanceId (event receiver / sync instance).')
  .option('--id <id:string>', 'Exact log row id (the synthesized hex), to deep-link one entry.')
  .option(
    '--search <term:string>',
    'Case-insensitive message substring (AND across terms). Repeatable.',
    {
      collect: true,
    },
  )
  .option('--data <expr:string>', 'Filter on a top-level data key: <path>:<value>. Repeatable.', {
    collect: true,
  })
  .option(
    '--since <duration:string>',
    'Only logs within the last <duration> (e.g. 30m, 2h, 1d). Shorthand for --from.',
  )
  .option('--from <iso:string>', 'Window start (ISO-8601). Overrides --since.')
  .option('--to <iso:string>', 'Window end (ISO-8601).')
  .option('--limit <n:number>', 'Page size (default 200, max 1000).')
  .option('--all', 'Paginate older pages until exhausted (uses the timestamp cursor).', {
    default: false,
  })
  .option('-f, --follow', 'Live tail: poll for new entries and stream them (tail -f style).', {
    default: false,
  })
  .option('--interval <seconds:number>', 'Poll interval for --follow (default 4, min 1).')
  .option('--timeout <seconds:number>', 'With --follow, stop after <seconds> (exit 124).')
  .option('-j, --json', 'Emit JSON instead of a table (one entry per line under --follow).', {
    default: false,
  })
  .example(
    'Errors across the platform in the last hour',
    'quickflo logs search --level error --since 1h',
  )
  .example('Live-tail a workflow’s logs', 'quickflo logs search --workflow <id> --follow')
  .example(
    'Why a connection keeps failing',
    'quickflo logs search --connection <id> --level error,warn -j',
  )
  .action(async (raw) => {
    const opts = raw as unknown as RawLogsOpts;
    await runLogsSearch({
      source: opts.source,
      level: opts.level,
      channel: opts.channel,
      provider: opts.provider,
      origin: opts.origin,
      tag: opts.tag,
      workflow: opts.workflow,
      execution: opts.execution,
      connection: opts.connection,
      connectionName: opts.connectionName,
      trigger: opts.trigger,
      instance: opts.instance,
      id: opts.id,
      search: opts.search,
      data: opts.data,
      since: opts.since,
      from: opts.from,
      to: opts.to,
      limit: opts.limit,
      all: opts.all,
      follow: opts.follow,
      interval: opts.interval,
      timeout: opts.timeout,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const logsFacets = new Command()
  .description(
    'Show facet counts (source / level / channel / provider / origin / tags) for the ' +
      'current filter + window. Use it to discover the filter space before drilling in. -j emits the raw facets object.',
  )
  .option('-o, --org <suid:string>', 'Organization SUID or UUID (or set QF_ORG)')
  .option('--api-url <url:string>', 'Override API base URL (or set QF_API_URL)')
  .option(
    '--source <s:string>',
    'Filter by source (workflow|connection|trigger|audit|event-receiver|integration-sync). Repeatable / CSV.',
    { collect: true },
  )
  .option('--level <l:string>', 'Filter by level (debug|info|warn|error). Repeatable / CSV.', {
    collect: true,
  })
  .option('--channel <c:string>', 'Filter by channel. Repeatable / CSV.', { collect: true })
  .option('--provider <p:string>', 'Filter by provider. Repeatable / CSV.', { collect: true })
  .option('--origin <o:string>', 'Filter by origin (core.log|engine). Repeatable / CSV.', {
    collect: true,
  })
  .option(
    '--tag <t:string>',
    'Filter to logs from workflows carrying any of these tags. Repeatable / CSV.',
    {
      collect: true,
    },
  )
  .option('--workflow <id:string>', 'Exact workflowId.')
  .option('--execution <id:string>', 'Exact executionId.')
  .option('--connection <id:string>', 'Exact connectionId.')
  .option('--connection-name <name:string>', 'Exact connection name.')
  .option('--trigger <id:string>', 'Exact triggerId.')
  .option('--instance <id:string>', 'Exact instanceId (event receiver / sync instance).')
  .option('--id <id:string>', 'Exact log row id (the synthesized hex), to deep-link one entry.')
  .option(
    '--search <term:string>',
    'Case-insensitive message substring (AND across terms). Repeatable.',
    {
      collect: true,
    },
  )
  .option('--data <expr:string>', 'Filter on a top-level data key: <path>:<value>. Repeatable.', {
    collect: true,
  })
  .option(
    '--since <duration:string>',
    'Only logs within the last <duration> (e.g. 30m, 2h, 1d). Shorthand for --from.',
  )
  .option('--from <iso:string>', 'Window start (ISO-8601). Overrides --since.')
  .option('--to <iso:string>', 'Window end (ISO-8601).')
  .option('-j, --json', 'Emit the raw facets object as JSON.', { default: false })
  .example('What is logging in the last day', 'quickflo logs facets --since 1d')
  .action(async (raw) => {
    const opts = raw as unknown as RawLogsOpts;
    await runLogsFacets({
      source: opts.source,
      level: opts.level,
      channel: opts.channel,
      provider: opts.provider,
      origin: opts.origin,
      tag: opts.tag,
      workflow: opts.workflow,
      execution: opts.execution,
      connection: opts.connection,
      connectionName: opts.connectionName,
      trigger: opts.trigger,
      instance: opts.instance,
      id: opts.id,
      search: opts.search,
      data: opts.data,
      since: opts.since,
      from: opts.from,
      to: opts.to,
      apiUrl: opts.apiUrl || Deno.env.get('QF_API_URL') || undefined,
      orgId: opts.org,
      json: opts.json,
    });
  });

const logs = new Command()
  .description('Query and tail the platform log stream (the Logs explorer surface).')
  .action(function () {
    this.showHelp();
  })
  .command('search', logsSearch)
  .command('facets', logsFacets);

try {
  await new Command()
    .name('quickflo')
    .version('1.5.0')
    .description('QuickFlo command-line interface.')
    .globalOption('--quiet', 'Suppress progress output; errors still print to stderr.', {
      action: () => setQuiet(true),
    })
    .command('auth', auth)
    .command('workflows', workflows)
    .command('packages', packages)
    .command('microapp', microapp)
    .command('connections', connections)
    .command('environments', environments)
    .command('triggers', triggers)
    .command('data-stores', dataStores)
    .command('dashboards', dashboards)
    .command('logs', logs)
    .command('backup', backup)
    .command('mcp', mcp)
    .command('skill', skill)
    .parse(Deno.args);
} catch (err) {
  Deno.exit(printError(err, wantsJsonErrors));
}
