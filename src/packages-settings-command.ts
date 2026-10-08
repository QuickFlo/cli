import { Command } from '@cliffy/command';
import { runPackagesSettings } from './packages-settings.ts';

/** Share only flags; auth/org selection continues through openSession. */
function command() {
  return new Command()
    .option('-o, --org <suid:string>', 'Organization SUID or UUID (or QF_ORG)')
    .option('-j, --json', 'Emit compact JSON', { default: false });
}

export function createPackagesSettingsCommand() {
  return new Command()
    .description('Read published settings contracts and configure installed package settings.')
    .command(
      'describe',
      command()
        .description(
          'Get installed settings sources, schemas, editable paths and packageVersionId.',
        )
        .arguments('<install-id:string>')
        .action(async (opts, installId) => {
          await runPackagesSettings({
            action: 'describe',
            installId,
            orgId: opts.org,
            json: opts.json,
          });
        }),
    )
    .command(
      'published',
      command()
        .description(
          'Get a publisher-owned version’s settings declarations for reuse in a publish descriptor.',
        )
        .arguments('<package-id:string> <version:string>')
        .action(async (opts, packageId, version) => {
          await runPackagesSettings({
            action: 'published',
            packageId,
            version,
            orgId: opts.org,
            json: opts.json,
          });
        }),
    )
    .command(
      'records',
      command()
        .description(
          'Read projected values, revisions and validation issues (50 records per page).',
        )
        .arguments('<install-id:string> <source-id:string>')
        .option('--key <key:string>', 'Read one record', { conflicts: ['after-key'] })
        .option('--after-key <key:string>', 'Continue after the last key of the previous page')
        .option('--all', 'Read every page', { default: false })
        .action(async (opts, installId, sourceId) => {
          await runPackagesSettings({
            action: 'records',
            installId,
            sourceId,
            orgId: opts.org,
            json: opts.json,
            key: opts.key,
            afterKey: opts.afterKey,
            all: opts.all,
          });
        }),
    )
    .command(
      'options',
      command()
        .description('Resolve dynamic choices through the installed package’s connection binding.')
        .arguments('<install-id:string> <source-id:string>')
        .option('--path <pointer:string>', 'Field JSON pointer, e.g. /listName', { required: true })
        .option('--search <text:string>', 'Filter choices')
        .option('--cursor <cursor:integer>', 'Cursor from the previous response')
        .option('--selected <value:string>', 'Include the current selection even if unavailable')
        .action(async (opts, installId, sourceId) => {
          await runPackagesSettings({
            action: 'options',
            installId,
            sourceId,
            orgId: opts.org,
            json: opts.json,
            path: opts.path,
            search: opts.search,
            cursor: opts.cursor,
            selected: opts.selected,
          });
        }),
    )
    .command(
      'save',
      command()
        .description(
          'Save explicit set/remove changes with the version and revision you read. Conflicts are not retried.',
        )
        .arguments('<install-id:string> <source-id:string>')
        .option('--file <file:string>', 'JSON {key, packageVersionId, revision, changes}', {
          required: true,
        })
        .option(
          '--dry-run',
          'Print the request without writing; does not perform server validation',
        )
        .action(async (opts, installId, sourceId) => {
          await runPackagesSettings({
            action: 'save',
            installId,
            sourceId,
            orgId: opts.org,
            json: opts.json,
            file: opts.file,
            dryRun: opts.dryRun,
          });
        }),
    )
    .command(
      'delete',
      command()
        .description('Delete a collection record when permitted by its settings contract.')
        .arguments('<install-id:string> <source-id:string>')
        .option('--file <file:string>', 'JSON {key, packageVersionId, revision}', {
          required: true,
        })
        .option(
          '--dry-run',
          'Print the request without writing; does not perform server validation',
        )
        .option('--yes', 'Skip confirmation')
        .action(async (opts, installId, sourceId) => {
          await runPackagesSettings({
            action: 'delete',
            installId,
            sourceId,
            orgId: opts.org,
            json: opts.json,
            file: opts.file,
            dryRun: opts.dryRun,
            yes: opts.yes,
          });
        }),
    );
}
