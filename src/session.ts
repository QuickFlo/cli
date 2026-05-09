/**
 * Every subcommand follows the same opening ceremony: resolve env config,
 * authenticate, resolve org, construct an ApiClient. `openSession` centralises
 * that so new commands cannot accidentally skip org resolution or print
 * banners to the wrong stream.
 *
 * All diagnostic output is written to stderr so commands that emit a payload
 * to stdout (e.g. `workflows get > wf.json`, `workflows list -j | jq`) pipe
 * cleanly.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, type ResolvedOrg, resolveOrganization } from './api.ts';
import { authenticate, type AuthResult } from './auth.ts';
import { type EnvConfig, resolveEnv } from './config.ts';

export interface OpenSessionOptions {
  apiUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  orgId?: string;
  username?: string;
  password?: string;
  noCache?: boolean;
}

export interface Session {
  client: ApiClient;
  org: ResolvedOrg;
  auth: AuthResult;
  envConfig: EnvConfig;
}

export async function openSession(
  opts: OpenSessionOptions,
  commandLabel: string,
): Promise<Session> {
  const orgInput = opts.orgId || Deno.env.get('QF_ORG');
  if (!orgInput) {
    console.error(
      colors.red('Error: -o/--org (or QF_ORG env var) is required'),
    );
    Deno.exit(1);
  }

  const envConfig = resolveEnv({
    apiUrl: opts.apiUrl,
    supabaseUrl: opts.supabaseUrl,
    supabaseAnonKey: opts.supabaseAnonKey,
  });

  console.error(colors.bold.cyan(`QuickFlo — ${commandLabel}`));
  console.error(colors.dim('─'.repeat(24)));
  console.error(`  API:  ${envConfig.apiUrl}`);

  const auth = await authenticate({
    envConfig,
    username: opts.username,
    password: opts.password,
    noCache: opts.noCache,
  });
  console.error(
    `  User: ${auth.email} ${colors.dim(auth.cached ? '(cached session)' : '(fresh login)')}`,
  );

  const org = await resolveOrganization(
    { apiUrl: envConfig.apiUrl, accessToken: auth.accessToken },
    orgInput,
  );
  console.error(
    `  Org:  ${org.name} ${colors.dim(org.suid ? `(${org.suid})` : `(${org.id})`)}`,
  );

  const client: ApiClient = {
    apiUrl: envConfig.apiUrl,
    orgId: org.id,
    accessToken: auth.accessToken,
  };
  return { client, org, auth, envConfig };
}
