/**
 * `quickflo packages init` — scaffold a `pkg.json` descriptor matching the
 * shape `packages publish --descriptor` reads (`PublishPackageVersionDto`).
 *
 * Non-interactive when every required field is supplied via flags
 * (`--name`, `--from-org`, `--roots`); otherwise prompts the user for the
 * missing fields. Resolves workflow names via `GET /workflows` so the
 * descriptor contains stable ids rather than display names.
 */

import { colors } from '@cliffy/ansi/colors';
import { resolve } from '@std/path';
import { type ApiClient, apiFetch } from './api.ts';
import { openSession } from './session.ts';

type Visibility = 'public' | 'unlisted' | 'private';

interface WorkflowRow {
  id: string;
  name: string;
}

interface WorkflowListResponse {
  data: WorkflowRow[];
}

async function promptLine(label: string, def?: string): Promise<string> {
  if (!Deno.stdin.isTerminal()) {
    if (def !== undefined) return def;
    throw new Error(
      `Missing "${label}" — re-run with the matching flag or in a TTY.`,
    );
  }
  const suffix = def ? ` ${colors.dim(`[${def}]`)}` : '';
  await Deno.stdout.write(new TextEncoder().encode(`${label}${suffix}: `));
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return def ?? '';
  const text = new TextDecoder().decode(buf.subarray(0, n)).trim();
  return text || (def ?? '');
}

async function resolveWorkflows(
  client: ApiClient,
  names: string[],
): Promise<WorkflowRow[]> {
  const out: WorkflowRow[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const params = new URLSearchParams();
    params.set('where[organizationId][$eq]', client.orgId);
    params.set('where[name][$eq]', name);
    params.set('where[packageInstallId]', 'null');
    params.set('options[limit]', '2');
    const res = await apiFetch<WorkflowListResponse>(
      client,
      `/workflows?${params.toString()}`,
    );
    const matches = res.data ?? [];
    if (matches.length === 0) {
      throw new Error(`Workflow "${name}" not found in source org.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Workflow name "${name}" is ambiguous (${matches.length} matches). Use the UUID instead.`,
      );
    }
    out.push(matches[0]);
  }
  return out;
}

function isValidVisibility(v: string): v is Visibility {
  return v === 'public' || v === 'unlisted' || v === 'private';
}

export interface PackagesInitOptions {
  /** Path to write the descriptor (default `./pkg.json`). */
  out?: string;
  /** Package local name (e.g. `onboarding`). */
  name?: string;
  /** First version to seed in the descriptor (default `0.1.0`). */
  version?: string;
  /** Short one-line summary. */
  summary?: string;
  /** Visibility on first publish (`public` | `unlisted` | `private`). */
  visibility?: string;
  /** Repeatable workflow names to include as roots. */
  roots?: string[];
  /** Source org to resolve workflow names against. Defaults to active org. */
  fromOrg?: string;
  apiUrl?: string;
  orgId?: string;
  /** Skip prompts; require every input via flags. */
  yes?: boolean;
}

export async function runPackagesInit(opts: PackagesInitOptions): Promise<void> {
  const sessionOpts = { ...opts, orgId: opts.fromOrg ?? opts.orgId };
  const { client } = await openSession(sessionOpts, 'packages init');

  const out = resolve(opts.out ?? 'pkg.json');
  try {
    await Deno.stat(out);
    throw new Error(`${out} already exists — refusing to overwrite.`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }

  const interactive = !opts.yes;

  const name = opts.name ??
    (interactive ? (await promptLine('Package name (e.g. onboarding)')).trim() : '');
  if (!name) throw new Error('Package name is required (--name or interactive prompt).');

  const version = opts.version ??
    (interactive ? await promptLine('Initial version', '0.1.0') : '0.1.0');

  const summary = opts.summary ?? (interactive ? await promptLine('Summary (one line)', '') : '');

  const visRaw = opts.visibility ??
    (interactive ? await promptLine('Visibility (public|unlisted|private)', 'private') : 'private');
  if (!isValidVisibility(visRaw)) {
    throw new Error(`--visibility must be public|unlisted|private (got "${visRaw}")`);
  }
  const visibility: Visibility = visRaw;

  const rootNames = opts.roots && opts.roots.length > 0
    ? opts.roots
    : interactive
    ? (await promptLine('Root workflow names (comma-separated)', ''))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    : [];
  if (rootNames.length === 0) {
    throw new Error(
      'At least one root workflow is required (--roots <name> or interactive prompt).',
    );
  }

  const workflows = await resolveWorkflows(client, rootNames);
  const roots = workflows.map((w) => ({
    kind: 'workflow' as const,
    workflowTemplateId: w.id,
  }));

  const descriptor: Record<string, unknown> = {
    package: { slug: name, name, visibility },
    version,
    roots,
  };
  if (summary) descriptor['summary'] = summary;

  await Deno.writeTextFile(out, JSON.stringify(descriptor, null, 2) + '\n');
  console.error(
    `${colors.green('✓')} wrote ${out} (${workflows.length} workflow root(s))`,
  );
  for (const w of workflows) {
    console.error(`  - workflow ${colors.bold(w.name)} ${colors.dim(w.id)}`);
  }
  console.error('');
  console.error(
    colors.dim(
      `Edit ${opts.out ?? 'pkg.json'} then run \`quickflo packages publish ${name} --descriptor ${
        opts.out ?? 'pkg.json'
      }\`.`,
    ),
  );
}
