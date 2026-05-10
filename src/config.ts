/**
 * Environment configuration for the quickflo CLI.
 *
 * Defaults target QuickFlo's hosted production deployment. Override the API
 * URL via the `QF_API_URL` env var or the matching CLI flag — useful for
 * self-hosted deployments and local dev.
 *
 * Auth is token-based (Personal Access Tokens minted in the web UI). The CLI
 * no longer needs Supabase URL or anon key, so those are gone.
 */

export interface EnvConfig {
  apiUrl: string;
}

const DEFAULTS: EnvConfig = {
  apiUrl: 'https://go.quickflo.app/api',
};

export interface ResolveEnvOptions {
  apiUrl?: string;
}

export function resolveEnv(opts: ResolveEnvOptions = {}): EnvConfig {
  const apiUrl = (opts.apiUrl || Deno.env.get('QF_API_URL') || DEFAULTS.apiUrl)
    .replace(/\/$/, '');
  return { apiUrl };
}
