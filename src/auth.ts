/**
 * Token-based auth for the QuickFlo CLI.
 *
 * The CLI no longer authenticates with email + password against Supabase.
 * Users mint a Personal Access Token in the QuickFlo web UI (Settings →
 * Access Tokens) and either set it as `QF_TOKEN` or run `quickflo auth login`
 * to store it. Every API request carries `Authorization: Bearer <token>`.
 *
 * Resolution order:
 *   1. `QF_TOKEN` env var
 *   2. Stored credential at `$XDG_CONFIG_HOME/quickflo/credentials.json`
 *      (mode 0600), keyed by API URL so multiple deployments don't collide
 *   3. Fail with a hint pointing to `quickflo auth login`
 */

import { colors } from '@cliffy/ansi/colors';
import { join } from '@std/path';
import type { EnvConfig } from './config.ts';
import { resolveEnv } from './config.ts';

interface StoredCredential {
  token: string;
  savedAt: string; // ISO timestamp, informational
}

interface CredentialsFile {
  version: 1;
  /** keyed by API URL (e.g. https://go.quickflo.app/api) */
  tokens: Record<string, StoredCredential>;
}

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
    if (parsed.version !== 1 || typeof parsed.tokens !== 'object') return null;
    return parsed as CredentialsFile;
  } catch {
    return null;
  }
}

async function writeCredentials(file: CredentialsFile): Promise<void> {
  const path = credentialsPath();
  await Deno.mkdir(join(path, '..'), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(file, null, 2), {
    mode: 0o600,
  });
}

export async function loadStoredToken(apiUrl: string): Promise<string | null> {
  const creds = await readCredentials();
  return creds?.tokens?.[apiUrl]?.token ?? null;
}

export async function storeToken(apiUrl: string, token: string): Promise<void> {
  const existing = (await readCredentials()) ?? { version: 1 as const, tokens: {} };
  existing.tokens[apiUrl] = {
    token,
    savedAt: new Date().toISOString(),
  };
  await writeCredentials(existing);
}

export async function clearToken(apiUrl: string): Promise<void> {
  const creds = await readCredentials();
  if (!creds || !creds.tokens[apiUrl]) return;
  delete creds.tokens[apiUrl];
  await writeCredentials(creds);
}

export interface ResolveTokenOptions {
  envConfig: EnvConfig;
}

export interface ResolveTokenResult {
  token: string;
  source: 'env' | 'stored';
}

export async function resolveToken(
  opts: ResolveTokenOptions,
): Promise<ResolveTokenResult> {
  const envToken = Deno.env.get('QF_TOKEN');
  if (envToken) {
    return { token: envToken, source: 'env' };
  }
  const stored = await loadStoredToken(opts.envConfig.apiUrl);
  if (stored) {
    return { token: stored, source: 'stored' };
  }
  console.error(
    colors.red('Error: no QuickFlo access token configured.') +
      '\n\n' +
      `  Run ${colors.bold('quickflo auth login')} to paste a token, or set ${
        colors.bold('QF_TOKEN')
      } in your env.\n` +
      `  Generate tokens in the QuickFlo web UI under ${colors.dim('Settings → Access Tokens')}.`,
  );
  Deno.exit(1);
}

export interface AccessibleOrg {
  id: string;
  suid?: string;
  name: string;
}

/**
 * Verify a token works and return the orgs it can access. Calls /auth/me,
 * which accepts both Supabase user JWTs and Personal Access Tokens. The
 * endpoint is read-only — using it here doesn't grant the token any rights
 * it didn't already have.
 */
export async function probeToken(
  envConfig: EnvConfig,
  token: string,
): Promise<{ organizations: AccessibleOrg[] }> {
  const res = await fetch(`${envConfig.apiUrl}/auth/me`, {
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
 * Read a single line from stdin, optionally with the echo masked with `*`.
 * Prompt is written to stderr so commands that emit a payload to stdout pipe
 * cleanly.
 *
 * The masked path runs the terminal in raw mode and parses each byte through
 * a tiny state machine that drops ANSI escape sequences. This matters because
 * modern terminals wrap pasted input in bracketed-paste markers
 * (`ESC[200~ ... ESC[201~`); without filtering, those bytes end up in the
 * captured string and the server rejects the token with a 401.
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
  type EscState = 'normal' | 'esc' | 'csi';
  let state: EscState = 'normal';
  try {
    while (true) {
      const n = Deno.stdin.readSync(buf);
      if (n === null || n === 0) break;
      const ch = buf[0];

      if (state === 'esc') {
        // After ESC: '[' opens a CSI sequence, anything else is a short
        // escape we swallow along with this byte.
        state = ch === 0x5b ? 'csi' : 'normal';
        continue;
      }
      if (state === 'csi') {
        // Skip parameter/intermediate bytes; CSI ends on a final byte 0x40-0x7e.
        if (ch >= 0x40 && ch <= 0x7e) state = 'normal';
        continue;
      }

      if (ch === 0x1b) {
        state = 'esc';
        continue;
      }
      if (ch === 0x0d || ch === 0x0a) break; // CR/LF
      if (ch === 0x03) {
        // Ctrl-C
        Deno.stdin.setRaw(false);
        Deno.stderr.writeSync(encoder.encode('\n'));
        Deno.exit(130);
      }
      if (ch === 0x7f || ch === 0x08) {
        // backspace — erase one character on screen too
        if (chars.length > 0) {
          chars.pop();
          Deno.stderr.writeSync(encoder.encode('\b \b'));
        }
        continue;
      }
      if (ch < 0x20 || ch > 0x7e) continue; // drop other non-printables
      chars.push(String.fromCharCode(ch));
      Deno.stderr.writeSync(encoder.encode('*'));
    }
  } finally {
    Deno.stdin.setRaw(false);
  }
  Deno.stderr.writeSync(encoder.encode('\n'));
  return chars.join('');
}

export interface AuthLoginOptions {
  apiUrl?: string;
}

export async function runAuthLogin(opts: AuthLoginOptions): Promise<void> {
  const envConfig = resolveEnv({ apiUrl: opts.apiUrl });

  console.error(colors.bold.cyan('QuickFlo — Sign in'));
  console.error(colors.dim('─'.repeat(24)));
  console.error(`  API: ${envConfig.apiUrl}`);
  console.error('');
  console.error(
    `  Generate a token at ${colors.dim('Settings → Access Tokens')} in the QuickFlo web UI,`,
  );
  console.error('  then paste it below. Input is masked.');
  console.error('');

  const token = promptStderr('Token:', true)?.trim();
  if (!token) {
    console.error(colors.red('Aborted: empty token.'));
    Deno.exit(1);
  }

  console.error(colors.dim('  Verifying…'));
  const { organizations } = await probeToken(envConfig, token);
  await storeToken(envConfig.apiUrl, token);

  console.error('');
  console.error(colors.green('  ✓ Signed in.'));
  if (organizations.length === 0) {
    console.error(
      colors.yellow(
        '  ! Token valid but no accessible organizations. Check the token has appropriate permissions.',
      ),
    );
  } else if (organizations.length === 1) {
    const org = organizations[0];
    console.error(
      `    Org: ${org.name} ${colors.dim(`(${org.suid ?? org.id})`)}`,
    );
  } else {
    console.error(`    ${organizations.length} accessible orgs:`);
    for (const org of organizations) {
      console.error(
        `      - ${org.name} ${colors.dim(`(${org.suid ?? org.id})`)}`,
      );
    }
  }
  console.error('');
  console.error(colors.dim(`  Saved to ${credentialsPath()}`));
}

export interface AuthLogoutOptions {
  apiUrl?: string;
}

export async function runAuthLogout(opts: AuthLogoutOptions): Promise<void> {
  const envConfig = resolveEnv({ apiUrl: opts.apiUrl });
  const had = await loadStoredToken(envConfig.apiUrl);
  await clearToken(envConfig.apiUrl);
  if (had) {
    console.error(colors.green(`✓ Signed out of ${envConfig.apiUrl}.`));
  } else {
    console.error(colors.dim(`Not signed in to ${envConfig.apiUrl}.`));
  }
}

export interface AuthStatusOptions {
  apiUrl?: string;
}

export async function runAuthStatus(opts: AuthStatusOptions): Promise<void> {
  const envConfig = resolveEnv({ apiUrl: opts.apiUrl });

  const envToken = Deno.env.get('QF_TOKEN');
  const stored = await loadStoredToken(envConfig.apiUrl);
  const token = envToken || stored;

  console.error(colors.bold.cyan('QuickFlo — Status'));
  console.error(colors.dim('─'.repeat(24)));
  console.error(`  API: ${envConfig.apiUrl}`);

  if (!token) {
    console.error(`  ${colors.dim('Not signed in.')}`);
    console.error('');
    console.error(
      `  Run ${colors.bold('quickflo auth login')} to paste a token, or set ${
        colors.bold('QF_TOKEN')
      }.`,
    );
    Deno.exit(0);
  }

  console.error(
    `  Token: ${colors.dim(envToken ? '(QF_TOKEN env)' : '(stored)')}`,
  );

  try {
    const { organizations } = await probeToken(envConfig, token);
    console.error(colors.green('  ✓ Token valid.'));
    if (organizations.length === 1) {
      const org = organizations[0];
      console.error(
        `    Org: ${org.name} ${colors.dim(`(${org.suid ?? org.id})`)}`,
      );
    } else {
      console.error(`    ${organizations.length} accessible orgs.`);
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
