/**
 * `quickflo microapp new <name>` — scaffold a Vite + TS micro-app pre-wired to
 * `@quickflo/app-sdk` (auth + onboarding + entitlement + webhook/form triggers).
 *
 * Pure local file generation: no API session, no network. Refuses to write into
 * a non-empty directory. The generated project pulls the SDK + entitlement
 * schema as normal npm dependencies (already published to public npm).
 */

import { colors } from '@cliffy/ansi/colors';
import { dirname, join, resolve } from '@std/path';
import { buildTemplate, type MicroappAuthMode } from './microapp-template.ts';
import { UserError, ValidationError } from './errors.ts';
import { info } from './log.ts';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SUPPORTED_FRAMEWORKS = ['vite-ts'];

export interface MicroappNewOptions {
  /** App name (kebab-case). Also the project directory name. */
  name: string;
  /** Parent directory to create the app in (default: cwd). */
  dir?: string;
  /** App SKU bound into the SDK (default: `name`). */
  appId?: string;
  /** Identity wiring: `supabase` (default) | `none`. */
  auth?: string;
  /** Project framework. Only `vite-ts` for now. */
  framework?: string;
  /** Emit anonymous free-demo helpers (Supabase only). */
  freeTier?: boolean;
}

function validateName(name: string): void {
  if (!name) {
    throw new ValidationError(
      'App name is required (e.g. `quickflo microapp new my-app`).',
    );
  }
  if (!KEBAB.test(name)) {
    throw new ValidationError(
      `App name "${name}" must be kebab-case: lowercase letters and digits, single hyphens, no leading hyphen or digit.`,
    );
  }
}

function resolveAuthMode(auth: string | undefined): MicroappAuthMode {
  const mode = auth ?? 'supabase';
  if (mode !== 'supabase' && mode !== 'none') {
    throw new ValidationError(`--auth must be "supabase" or "none" (got "${mode}").`);
  }
  return mode;
}

function validateFramework(framework: string | undefined): void {
  const fw = framework ?? 'vite-ts';
  if (!SUPPORTED_FRAMEWORKS.includes(fw)) {
    throw new ValidationError(
      `--framework "${fw}" is not supported yet (only: ${SUPPORTED_FRAMEWORKS.join(', ')}).`,
    );
  }
}

async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) {
      // A file at the target path counts as "occupied".
      return true;
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return false;
    }
    throw e;
  }
  for await (const _entry of Deno.readDir(path)) {
    return true;
  }
  return false;
}

export async function runMicroappNew(opts: MicroappNewOptions): Promise<void> {
  validateName(opts.name);
  validateFramework(opts.framework);
  const authMode = resolveAuthMode(opts.auth);
  const appId = opts.appId ?? opts.name;
  const freeTier = opts.freeTier ?? false;
  if (freeTier && authMode !== 'supabase') {
    throw new ValidationError(
      '--free-tier needs Supabase identity (anonymous sign-ins are a Supabase feature). Drop --auth none, or drop --free-tier.',
    );
  }

  const parent = resolve(opts.dir ?? '.');
  const target = join(parent, opts.name);

  if (await isNonEmptyDir(target)) {
    throw new UserError(`${target} already exists and is not empty — refusing to overwrite.`);
  }

  const files = buildTemplate({ name: opts.name, appId, authMode, freeTier });

  for (const [rel, contents] of Object.entries(files)) {
    const path = join(target, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, contents);
  }

  const fileCount = Object.keys(files).length;
  info(
    `${colors.green('✓')} scaffolded ${colors.bold(opts.name)} ` +
      colors.dim(
        `(${fileCount} files, auth: ${authMode}, app id: ${appId}${freeTier ? ', free-tier' : ''})`,
      ),
  );
  info('');
  info(colors.dim('Next:'));
  info(`  cd ${opts.name}`);
  info(`  pnpm install   ${colors.dim('# or npm install')}`);
  info('  pnpm dev');
  info('');
  info(colors.dim('Then finish the backend wiring documented in README.md.'));
}
