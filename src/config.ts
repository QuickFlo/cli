/**
 * Environment configuration for the quickflo CLI.
 *
 * Defaults target QuickFlo's hosted production deployment. Override any value
 * via env vars (`QF_API_URL`, `QF_SUPABASE_URL`, `QF_SUPABASE_ANON_KEY`) or
 * matching CLI flags — useful for self-hosted deployments and local dev.
 *
 * Supabase anon keys are public by design and match the values shipped to the
 * UI bundle — they are not secrets.
 */

export interface EnvConfig {
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

const DEFAULTS: EnvConfig = {
  apiUrl: 'https://go.quickflo.app/api',
  supabaseUrl: 'https://bztnikutwclqlvtqbukc.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6dG5pa3V0d2NscWx2dHFidWtjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM0NjUzNTYsImV4cCI6MjA1OTA0MTM1Nn0.uyc5XfZtifk7EhfRaG9ctx02GRiCvx8k4zHt8xviyB0',
};

export interface ResolveEnvOptions {
  apiUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export function resolveEnv(opts: ResolveEnvOptions = {}): EnvConfig {
  const apiUrl = (opts.apiUrl || Deno.env.get('QF_API_URL') || DEFAULTS.apiUrl)
    .replace(/\/$/, '');
  const supabaseUrl = (opts.supabaseUrl || Deno.env.get('QF_SUPABASE_URL') || DEFAULTS.supabaseUrl)
    .replace(/\/$/, '');
  const supabaseAnonKey = opts.supabaseAnonKey ||
    Deno.env.get('QF_SUPABASE_ANON_KEY') ||
    DEFAULTS.supabaseAnonKey;
  return { apiUrl, supabaseUrl, supabaseAnonKey };
}
