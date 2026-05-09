/**
 * Supabase auth via the GoTrue REST API. We call the endpoints directly to
 * avoid pulling in the full `@supabase/supabase-js` SDK and its Node polyfills.
 *
 * Sessions are cached per (env, email) at $XDG_CONFIG_HOME/quickflo/session.json
 * so repeat runs within the ~1h access-token TTL skip the password round-trip.
 * Expired access tokens are transparently refreshed; if the refresh token is
 * also rejected we fall back to password login.
 */

import { colors } from '@cliffy/ansi/colors';
import { join } from '@std/path';
import type { EnvConfig, EnvName } from './config.ts';

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  user?: { id: string; email?: string };
}

interface CachedSession extends SupabaseSession {
  env: EnvName;
  email: string;
}

function sessionCachePath(): string {
  const xdg = Deno.env.get('XDG_CONFIG_HOME');
  const home = Deno.env.get('HOME') ?? '';
  const base = xdg || join(home, '.config');
  return join(base, 'quickflo', 'session.json');
}

async function readCachedSession(
  env: EnvName,
  email: string,
): Promise<CachedSession | null> {
  try {
    const raw = await Deno.readTextFile(sessionCachePath());
    const parsed = JSON.parse(raw) as CachedSession;
    if (parsed.env !== env || parsed.email !== email) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedSession(session: CachedSession): Promise<void> {
  const path = sessionCachePath();
  await Deno.mkdir(join(path, '..'), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(session, null, 2), {
    mode: 0o600,
  });
}

function isAccessTokenFresh(session: SupabaseSession, skewSeconds = 60): boolean {
  const now = Math.floor(Date.now() / 1000);
  return session.expires_at > now + skewSeconds;
}

async function supabaseTokenRequest(
  env: EnvConfig,
  grantType: 'password' | 'refresh_token',
  body: Record<string, string>,
): Promise<SupabaseSession> {
  const res = await fetch(
    `${env.supabaseUrl}/auth/v1/token?grant_type=${grantType}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Supabase auth ${res.status}: ${text || res.statusText}`,
    );
  }
  return (await res.json()) as SupabaseSession;
}

function promptStderr(prompt: string, hidden = false): string | null {
  // Writing the prompt to stderr keeps stdout reserved for command payloads.
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

  // Hidden (password) prompt — read with echo off.
  Deno.stderr.writeSync(encoder.encode(prompt + ' '));
  try {
    Deno.stdin.setRaw(true);
  } catch {
    // Not a TTY — fall back to visible read rather than failing.
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
  const buf = new Uint8Array(1);
  const chars: string[] = [];
  while (true) {
    const n = Deno.stdin.readSync(buf);
    if (n === null || n === 0) break;
    const ch = buf[0];
    if (ch === 0x0d || ch === 0x0a) break; // CR/LF
    if (ch === 0x7f || ch === 0x08) {
      // backspace
      chars.pop();
      continue;
    }
    if (ch === 0x03) {
      // Ctrl-C
      Deno.stdin.setRaw(false);
      Deno.stderr.writeSync(encoder.encode('\n'));
      Deno.exit(130);
    }
    chars.push(String.fromCharCode(ch));
  }
  Deno.stdin.setRaw(false);
  Deno.stderr.writeSync(encoder.encode('\n'));
  return chars.join('');
}

export interface AuthOptions {
  env: EnvName;
  envConfig: EnvConfig;
  username?: string;
  password?: string;
  /** If true, force a fresh password login and ignore any cached session. */
  noCache?: boolean;
}

export interface AuthResult {
  accessToken: string;
  email: string;
  cached: boolean;
}

export async function authenticate(opts: AuthOptions): Promise<AuthResult> {
  const email = opts.username ||
    Deno.env.get('QF_USERNAME') ||
    promptStderr('Email:') ||
    '';
  if (!email) throw new Error('username is required');

  // Try cached session first (access token, then refresh).
  if (!opts.noCache) {
    const cached = await readCachedSession(opts.env, email);
    if (cached) {
      if (isAccessTokenFresh(cached)) {
        return { accessToken: cached.access_token, email, cached: true };
      }
      try {
        const refreshed = await supabaseTokenRequest(
          opts.envConfig,
          'refresh_token',
          { refresh_token: cached.refresh_token },
        );
        const next: CachedSession = { ...refreshed, env: opts.env, email };
        await writeCachedSession(next);
        return { accessToken: refreshed.access_token, email, cached: true };
      } catch {
        // fall through to password login
      }
    }
  }

  const password = opts.password ||
    Deno.env.get('QF_PASSWORD') ||
    promptStderr('Password:', true) ||
    '';
  if (!password) throw new Error('password is required');

  console.error(colors.dim(`  Logging in as ${email}…`));
  const session = await supabaseTokenRequest(opts.envConfig, 'password', {
    email,
    password,
  });
  const toCache: CachedSession = { ...session, env: opts.env, email };
  await writeCachedSession(toCache);
  return { accessToken: session.access_token, email, cached: false };
}
