/**
 * Every subcommand follows the same opening ceremony: resolve env config,
 * resolve a token, resolve org, construct an ApiClient. `openSession`
 * centralises that so new commands cannot accidentally skip org resolution
 * or print banners to the wrong stream.
 *
 * All diagnostic output is written to stderr so commands that emit a payload
 * to stdout (e.g. `workflows get > wf.json`, `workflows list -j | jq`) pipe
 * cleanly.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, type ResolvedOrg, resolveOrganization } from './api.ts';
import { probeToken, resolveToken } from './auth.ts';
import { type EnvConfig, resolveEnv } from './config.ts';

export interface OpenSessionOptions {
  apiUrl?: string;
  orgId?: string;
}

export interface Session {
  client: ApiClient;
  org: ResolvedOrg;
  envConfig: EnvConfig;
  tokenSource: 'env' | 'stored';
}

export async function openSession(
  opts: OpenSessionOptions,
  commandLabel: string,
): Promise<Session> {
  const envConfig = resolveEnv({ apiUrl: opts.apiUrl });

  console.error(colors.bold.cyan(`QuickFlo — ${commandLabel}`));
  console.error(colors.dim('─'.repeat(24)));
  console.error(`  API:  ${envConfig.apiUrl}`);

  const { token, source } = await resolveToken({ envConfig });
  console.error(
    `  Auth: ${colors.dim(source === 'env' ? '(QF_TOKEN env)' : '(stored token)')}`,
  );

  // Single round-trip to /auth/me: validates the token AND returns every org
  // it can access. We pick from that list rather than re-querying the API
  // for org lookup.
  const { organizations } = await probeToken(envConfig, token);

  if (organizations.length === 0) {
    console.error(
      colors.red(
        'Error: token has no accessible organizations. Verify the token has appropriate permissions.',
      ),
    );
    Deno.exit(1);
  }

  const orgInput = opts.orgId || Deno.env.get('QF_ORG');
  let org: ResolvedOrg;

  if (orgInput) {
    org = resolveOrganization(organizations, orgInput);
  } else if (organizations.length === 1) {
    org = organizations[0];
  } else {
    console.error(
      colors.red('Error: -o/--org (or QF_ORG env var) is required.') +
        '\n' +
        `  This token can access ${organizations.length} orgs:`,
    );
    for (const o of organizations) {
      console.error(`    - ${o.name} ${colors.dim(`(${o.suid ?? o.id})`)}`);
    }
    Deno.exit(1);
  }

  console.error(
    `  Org:  ${org.name} ${colors.dim(org.suid ? `(${org.suid})` : `(${org.id})`)}`,
  );

  const client: ApiClient = {
    apiUrl: envConfig.apiUrl,
    orgId: org.id,
    accessToken: token,
  };
  return { client, org, envConfig, tokenSource: source };
}
