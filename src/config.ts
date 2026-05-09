/**
 * Environment presets for the quickflo CLI.
 * Supabase anon keys are public by design and match the values shipped to the
 * UI bundle — they are not secrets.
 */

export type EnvName = 'local' | 'prod';

export interface EnvConfig {
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const ENV_PRESETS: Record<EnvName, EnvConfig> = {
  local: {
    apiUrl: 'http://localhost:3000/api',
    supabaseUrl: 'http://localhost:54321',
    supabaseAnonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  },
  prod: {
    apiUrl: 'https://go.quickflo.app/api',
    supabaseUrl: 'https://bztnikutwclqlvtqbukc.supabase.co',
    supabaseAnonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6dG5pa3V0d2NscWx2dHFidWtjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM0NjUzNTYsImV4cCI6MjA1OTA0MTM1Nn0.uyc5XfZtifk7EhfRaG9ctx02GRiCvx8k4zHt8xviyB0',
  },
};

export function resolveEnv(env: EnvName, apiUrlOverride?: string): EnvConfig {
  const preset = ENV_PRESETS[env];
  const apiUrl = (apiUrlOverride || preset.apiUrl).replace(/\/$/, '');
  return { ...preset, apiUrl };
}
