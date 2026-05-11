/**
 * Token-based auth for the QuickFlo CLI, with named profiles for managing
 * multiple PATs across orgs / deployments.
 *
 * Users mint a Personal Access Token in the QuickFlo web UI (Settings →
 * Access Tokens) and either:
 *   - run `quickflo auth login` to save it as a named profile, or
 *   - set `QF_TOKEN` for ad-hoc one-shot use.
 *
 * Profiles are stored at `$XDG_CONFIG_HOME/quickflo/credentials.json` (mode
 * 0600) keyed by name. Each profile bundles its api URL + token + cached org
 * metadata, so switching profiles switches everything in one move.
 *
 * Resolution order, highest priority first:
 *   1. `QF_TOKEN` env var (ad-hoc, profile-less)
 *   2. `QF_PROFILE` env var (session-scoped profile selection)
 *   3. `currentProfile` from credentials file (long-lived active profile)
 *   4. Fail with a hint pointing to `quickflo auth login`.
 */

import { colors } from '@cliffy/ansi/colors';
import { join } from '@std/path';

export interface Profile {
  apiUrl: string;
  token: string;
  /** Cached at login; informational only, surfaced in `auth list`. */
  orgSuid?: string;
  orgName?: string;
  savedAt: string;
}

interface CredentialsFile {
  version: 2;
  /** Name of the active profile, or null when none is selected. */
  currentProfile: string | null;
  profiles: Record<string, Profile>;
}

const DEFAULT_API_URL = 'https://go.quickflo.app/api';

export function credentialsPath(): string {
  const xdg = Deno.env.get('XDG_CONFIG_HOME');
  const home = Deno.env.get('HOME') ?? '';
  const base = xdg || join(home, '.config');
  return join(base, 'quickflo', 'credentials.json');
}

async function readCredentials(): Promise<CredentialsFile | null> {
  try {
    const raw = await Deno.readTextFile(credentialsPath());
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
    if (parsed.version !== 2 || typeof parsed.profiles !== 'object') return null;
    return parsed as CredentialsFile;
  } catch {
    return null;
  }
}

async function writeCredentials(file: CredentialsFile): Promise<void> {
  const path = credentialsPath();
  try {
    await Deno.mkdir(join(path, '..'), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(file, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not write credentials file at ${path}: ${reason}`);
  }
}

async function loadOrInit(): Promise<CredentialsFile> {
  return (
    (await readCredentials()) ?? {
      version: 2,
      currentProfile: null,
      profiles: {},
    }
  );
}

export async function saveProfile(
  name: string,
  profile: Profile,
  makeCurrent: boolean,
): Promise<void> {
  const creds = await loadOrInit();
  creds.profiles[name] = profile;
  if (makeCurrent) {
    creds.currentProfile = name;
  }
  await writeCredentials(creds);
}

export async function deleteProfile(name: string): Promise<boolean> {
  const creds = await readCredentials();
  if (!creds || !creds.profiles[name]) return false;
  delete creds.profiles[name];
  if (creds.currentProfile === name) {
    creds.currentProfile = null;
  }
  await writeCredentials(creds);
  return true;
}

export async function setCurrentProfile(name: string): Promise<boolean> {
  const creds = await readCredentials();
  if (!creds || !creds.profiles[name]) return false;
  creds.currentProfile = name;
  await writeCredentials(creds);
  return true;
}

export interface ResolvedSession {
  token: string;
  apiUrl: string;
  /** null when QF_TOKEN was used directly (no profile). */
  profileName: string | null;
  source: 'env-token' | 'env-profile' | 'current-profile';
}

/**
 * Resolve the effective session: token, api URL, profile name. Honors
 * `QF_TOKEN` (ad-hoc bypass), `QF_PROFILE` (session-scoped), and the file's
 * `currentProfile`, in that priority order.
 */
export async function resolveSession(): Promise<ResolvedSession> {
  const envToken = Deno.env.get('QF_TOKEN');
  if (envToken) {
    const apiUrl = (Deno.env.get('QF_API_URL') || DEFAULT_API_URL).replace(
      /\/$/,
      '',
    );
    return {
      token: envToken,
      apiUrl,
      profileName: null,
      source: 'env-token',
    };
  }

  const creds = await readCredentials();
  const envProfile = Deno.env.get('QF_PROFILE');
  const profileName = envProfile || creds?.currentProfile;

  if (!profileName || !creds?.profiles?.[profileName]) {
    failNoSession(profileName, creds);
  }

  const profile = creds!.profiles[profileName!];
  return {
    token: profile.token,
    apiUrl: profile.apiUrl,
    profileName: profileName!,
    source: envProfile ? 'env-profile' : 'current-profile',
  };
}

function failNoSession(
  requestedProfile: string | null | undefined,
  creds: CredentialsFile | null,
): never {
  if (requestedProfile && creds && !creds.profiles[requestedProfile]) {
    const available = Object.keys(creds.profiles).sort();
    console.error(
      colors.red(`Error: profile "${requestedProfile}" not found.`) +
        (available.length
          ? '\n  Available profiles: ' + available.join(', ')
          : '\n  No profiles saved. Run ' +
            colors.bold('quickflo auth login') +
            ' to create one.'),
    );
  } else {
    console.error(
      colors.red('Error: no QuickFlo profile is active.') +
        '\n\n' +
        `  Run ${colors.bold('quickflo auth login')} to save a token, set ${
          colors.bold('QF_TOKEN')
        } for one-shot use, or ${
          colors.bold('quickflo auth use <name>')
        } to pick an existing profile.`,
    );
  }
  Deno.exit(1);
}

export interface AccessibleOrg {
  id: string;
  suid?: string;
  name: string;
}

/**
 * Verify a token works and return the orgs it can access. Calls /auth/me,
 * which accepts both Supabase user JWTs and Personal Access Tokens.
 */
export async function probeToken(
  apiUrl: string,
  token: string,
): Promise<{ organizations: AccessibleOrg[] }> {
  const res = await fetch(`${apiUrl}/auth/me`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token rejected (${res.status}): ${text || res.statusText}`);
  }
  const body = (await res.json()) as { organizations?: AccessibleOrg[] };
  return { organizations: body.organizations ?? [] };
}

/**
 * Read a single line from stdin, optionally with the echo masked. Prompt is
 * written to stderr so commands that emit a payload to stdout pipe cleanly.
 */
export function promptStderr(prompt: string, hidden = false): string | null {
  const encoder = new TextEncoder();

  if (!hidden) {
    Deno.stderr.writeSync(encoder.encode(prompt + ' '));
    const buf = new Uint8Array(1024);
    const chars: string[] = [];
    while (true) {
      const n = Deno.stdin.readSync(buf);
      if (n === null || n === 0) break;
      for (let i = 0; i < n; i++) {
        const ch = buf[i];
        if (ch === 0x0a) return chars.join('');
        if (ch === 0x0d) continue;
        chars.push(String.fromCharCode(ch));
      }
    }
    return chars.join('');
  }

  Deno.stderr.writeSync(encoder.encode(prompt + ' '));
  Deno.stdin.setRaw(true);
  const buf = new Uint8Array(1);
  const chars: string[] = [];
  while (true) {
    const n = Deno.stdin.readSync(buf);
    if (n === null || n === 0) break;
    const ch = buf[0];
    if (ch === 0x0d || ch === 0x0a) break;
    if (ch === 0x7f || ch === 0x08) {
      // backspace — erase the trailing asterisk visually too
      if (chars.length > 0) {
        chars.pop();
        Deno.stderr.writeSync(encoder.encode('\b \b'));
      }
      continue;
    }
    if (ch === 0x03) {
      // Ctrl-C
      Deno.stdin.setRaw(false);
      Deno.stderr.writeSync(encoder.encode('\n'));
      Deno.exit(130);
    }
    chars.push(String.fromCharCode(ch));
    Deno.stderr.writeSync(encoder.encode('*'));
  }
  Deno.stdin.setRaw(false);
  Deno.stderr.writeSync(encoder.encode('\n'));
  return chars.join('');
}

function resolveApiUrl(apiUrl?: string): string {
  return (apiUrl || Deno.env.get('QF_API_URL') || DEFAULT_API_URL).replace(
    /\/$/,
    '',
  );
}

/**
 * Derive a profile name from a probed org. Defaults to the org SUID; falls
 * back to a short id slice when no SUID is present. Honors an explicit
 * --as override.
 */
function deriveProfileName(
  explicit: string | undefined,
  org: AccessibleOrg | undefined,
): string {
  if (explicit?.trim()) return explicit.trim();
  if (org?.suid) return org.suid;
  if (org?.id) return org.id.slice(0, 8);
  return 'default';
}

export interface AuthLoginOptions {
  apiUrl?: string;
  /** Optional explicit profile name; otherwise derived from org SUID. */
  as?: string;
}

export async function runAuthLogin(opts: AuthLoginOptions): Promise<void> {
  const apiUrl = resolveApiUrl(opts.apiUrl);

  console.error(colors.bold.cyan('QuickFlo — Sign in'));
  console.error(colors.dim('─'.repeat(24)));
  console.error(`  API: ${apiUrl}`);
  console.error('');
  console.error(
    `  Generate a token at ${colors.dim('Settings → Access Tokens')} in the QuickFlo web UI,`,
  );
  console.error('  then paste it below. Input is hidden.');
  console.error('');

  const token = promptStderr('Token:', true)?.trim();
  if (!token) {
    console.error(colors.red('Aborted: empty token.'));
    Deno.exit(1);
  }

  console.error(colors.dim('  Verifying…'));
  const { organizations } = await probeToken(apiUrl, token);
  if (organizations.length === 0) {
    console.error(
      colors.yellow(
        '  ! Token valid but no accessible organizations. Saving anyway.',
      ),
    );
  }

  const org = organizations[0];
  const name = deriveProfileName(opts.as, org);

  const existing = await readCredentials();
  const willOverwrite = !!existing?.profiles?.[name];

  await saveProfile(
    name,
    {
      apiUrl,
      token,
      orgSuid: org?.suid,
      orgName: org?.name,
      savedAt: new Date().toISOString(),
    },
    true, // make current
  );

  console.error('');
  console.error(colors.green(`  ✓ Signed in.`));
  console.error(
    `    Profile: ${colors.bold(name)}${willOverwrite ? colors.dim(' (overwrote existing)') : ''}`,
  );
  if (org) {
    console.error(
      `    Org: ${org.name} ${colors.dim(`(${org.suid ?? org.id})`)}`,
    );
  }
  console.error(`    ${colors.dim('Active.')}`);
  console.error('');
  console.error(colors.dim(`  Saved to ${credentialsPath()}`));
}

export interface AuthLogoutOptions {
  /** If set, logs out the named profile. Otherwise logs out the current one. */
  profile?: string;
}

export async function runAuthLogout(opts: AuthLogoutOptions): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    console.error(colors.dim('Not signed in to any profile.'));
    return;
  }

  const target = opts.profile || creds.currentProfile;
  if (!target) {
    console.error(colors.dim('No active profile to sign out of.'));
    return;
  }

  const removed = await deleteProfile(target);
  if (!removed) {
    console.error(
      colors.red(`Profile "${target}" not found.`) +
        (Object.keys(creds.profiles).length
          ? '\n  Available: ' + Object.keys(creds.profiles).sort().join(', ')
          : ''),
    );
    Deno.exit(1);
  }

  console.error(colors.green(`✓ Removed profile "${target}".`));
}

export interface AuthStatusOptions {
  json?: boolean;
}

export async function runAuthStatus(opts: AuthStatusOptions): Promise<void> {
  if (opts.json) {
    try {
      const session = await resolveSession();
      console.log(
        JSON.stringify(
          {
            apiUrl: session.apiUrl,
            profileName: session.profileName,
            source: session.source,
          },
          null,
          2,
        ),
      );
    } catch {
      console.log(JSON.stringify({ active: false }));
      Deno.exit(1);
    }
    return;
  }

  console.error(colors.bold.cyan('QuickFlo — Status'));
  console.error(colors.dim('─'.repeat(24)));

  const envToken = Deno.env.get('QF_TOKEN');
  if (envToken) {
    const apiUrl = resolveApiUrl();
    console.error(`  Source: ${colors.dim('QF_TOKEN env (one-shot)')}`);
    console.error(`  API:    ${apiUrl}`);
    await probeAndPrint(apiUrl, envToken);
    return;
  }

  const creds = await readCredentials();
  const envProfile = Deno.env.get('QF_PROFILE');
  const profileName = envProfile || creds?.currentProfile;

  if (!profileName || !creds?.profiles?.[profileName]) {
    console.error(`  ${colors.dim('Not signed in.')}`);
    console.error('');
    console.error(
      `  Run ${colors.bold('quickflo auth login')} to save a profile.`,
    );
    Deno.exit(0);
  }

  const profile = creds.profiles[profileName];
  console.error(
    `  Source:  ${colors.dim(envProfile ? 'QF_PROFILE env' : 'active profile')}`,
  );
  console.error(`  Profile: ${colors.bold(profileName)}`);
  console.error(`  API:     ${profile.apiUrl}`);
  if (profile.orgName) {
    console.error(
      `  Org:     ${profile.orgName} ${colors.dim(`(${profile.orgSuid ?? '—'})`)}`,
    );
  }
  await probeAndPrint(profile.apiUrl, profile.token);
}

async function probeAndPrint(apiUrl: string, token: string): Promise<void> {
  try {
    const { organizations } = await probeToken(apiUrl, token);
    console.error(colors.green('  ✓ Token valid.'));
    if (organizations.length > 1) {
      console.error(`  ${organizations.length} accessible orgs.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(colors.red(`  ✗ Token invalid: ${msg}`));
    console.error(
      colors.dim(`  Run ${colors.bold('quickflo auth login')} to refresh.`),
    );
    Deno.exit(1);
  }
}

export interface AuthListOptions {
  json?: boolean;
}

export async function runAuthList(opts: AuthListOptions): Promise<void> {
  const creds = await readCredentials();
  const profiles = creds?.profiles ?? {};
  const current = creds?.currentProfile;
  const names = Object.keys(profiles).sort();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          currentProfile: current,
          profiles: names.map((name) => ({
            name,
            apiUrl: profiles[name].apiUrl,
            orgSuid: profiles[name].orgSuid,
            orgName: profiles[name].orgName,
            savedAt: profiles[name].savedAt,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (names.length === 0) {
    console.error(
      colors.dim('No profiles saved. Run ') +
        colors.bold('quickflo auth login') +
        colors.dim(' to create one.'),
    );
    return;
  }

  // Compact api URL: strip protocol + trailing /api so the column doesn't
  // dominate the table when everything is on go.quickflo.app.
  const endpoint = (apiUrl: string) => apiUrl.replace(/^https?:\/\//, '').replace(/\/api\/?$/, '');

  const nameW = Math.max('NAME'.length, ...names.map((n) => n.length));
  const orgW = Math.max(
    'ORG'.length,
    ...names.map((n) => (profiles[n].orgName ?? '—').length),
  );
  const suidW = Math.max(
    'SUID'.length,
    ...names.map((n) => (profiles[n].orgSuid ?? '—').length),
  );

  console.log(
    `  ${colors.bold('NAME'.padEnd(nameW))}  ${colors.bold('ORG'.padEnd(orgW))}  ${
      colors.bold('SUID'.padEnd(suidW))
    }  ${colors.bold('ENDPOINT')}`,
  );
  for (const name of names) {
    const profile = profiles[name];
    const marker = name === current ? colors.green('*') : ' ';
    console.log(
      `${marker} ${name.padEnd(nameW)}  ${(profile.orgName ?? '—').padEnd(orgW)}  ${
        (profile.orgSuid ?? '—').padEnd(suidW)
      }  ${colors.dim(endpoint(profile.apiUrl))}`,
    );
  }
}

export interface AuthUseOptions {
  name: string;
}

export async function runAuthUse(opts: AuthUseOptions): Promise<void> {
  const ok = await setCurrentProfile(opts.name);
  if (!ok) {
    const creds = await readCredentials();
    const available = Object.keys(creds?.profiles ?? {}).sort();
    console.error(
      colors.red(`Profile "${opts.name}" not found.`) +
        (available.length
          ? '\n  Available: ' + available.join(', ')
          : '\n  No profiles saved. Run ' +
            colors.bold('quickflo auth login') +
            ' first.'),
    );
    Deno.exit(1);
  }
  const profile = (await readCredentials())!.profiles[opts.name];
  console.error(colors.green(`✓ Active profile: ${colors.bold(opts.name)}`));
  if (profile.orgName) {
    console.error(
      `  ${profile.orgName} ${colors.dim(`(${profile.orgSuid ?? '—'})`)}`,
    );
  }
}
