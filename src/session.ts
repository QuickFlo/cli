/**
 * Every subcommand follows the same opening ceremony: resolve the active
 * profile (token + apiUrl), probe /auth/me to validate and pick an org,
 * construct an ApiClient. `openSession` centralises that so new commands
 * cannot accidentally skip org resolution or print banners to the wrong
 * stream.
 *
 * Diagnostic output goes to stderr so commands that emit a payload to stdout
 * pipe cleanly.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, type ResolvedOrg, resolveOrganization } from './api.ts';
import { probeToken, resolveSession } from './auth.ts';

export interface OpenSessionOptions {
  orgId?: string;
}

export interface Session {
  client: ApiClient;
  org: ResolvedOrg;
  apiUrl: string;
  profileName: string | null;
}

export async function openSession(
  opts: OpenSessionOptions,
  commandLabel: string,
): Promise<Session> {
  const { token, apiUrl, profileName, source } = await resolveSession();

  console.error(colors.bold.cyan(`QuickFlo — ${commandLabel}`));
  console.error(colors.dim('─'.repeat(24)));
  console.error(`  API:     ${apiUrl}`);

  if (profileName) {
    console.error(
      `  Profile: ${profileName} ${
        colors.dim(`(${source === 'env-profile' ? 'QF_PROFILE env' : 'active'})`)
      }`,
    );
  } else {
    console.error(`  Auth:    ${colors.dim('QF_TOKEN env (one-shot)')}`);
  }

  // Single round-trip to /auth/me: validates the token AND returns every org
  // it can access. We pick from that list rather than re-querying the API
  // for org lookup.
  const { organizations } = await probeToken(apiUrl, token);

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
    `  Org:     ${org.name} ${colors.dim(org.suid ? `(${org.suid})` : `(${org.id})`)}`,
  );

  const client: ApiClient = {
    apiUrl,
    orgId: org.id,
    accessToken: token,
  };
  return { client, org, apiUrl, profileName };
}
