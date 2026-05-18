/**
 * OAuth browser-handoff subflow for OAuth-typed connections.
 *
 * Why this exists: OAuth credentials can't be authored as JSON — the secret
 * (access token + refresh token) only materializes after the user completes
 * a provider consent page. Until the platform adds CLI loopback or device-
 * code endpoints, the CLI opens the browser at the existing
 * `/connections/oauth/:providerId/authorize` endpoint and polls until the
 * connection materializes server-side.
 *
 * Precondition: the user must already be signed into the QuickFlo web UI in
 * their default browser as the same account the CLI is using (the
 * `/authorize` endpoint is `UserGuard`-gated, not token-gated). We print
 * this precondition prominently before opening the browser.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';

interface ProvidersResponse {
  providers: Array<{ id: string; name?: string }>;
}

interface ConnectionRow {
  id: string;
  name: string;
  type: string;
  createdAt?: string;
}

interface ConnectionListResponse {
  data: ConnectionRow[];
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

async function openBrowser(url: string): Promise<void> {
  const platform = Deno.build.os;
  const [cmd, ...args]: [string, ...string[]] = platform === 'darwin'
    ? ['open', url]
    : platform === 'windows'
    ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  try {
    const result = await new Deno.Command(cmd, { args, stderr: 'null', stdout: 'null' }).output();
    if (!result.success) {
      throw new Error(`browser launcher exited ${result.code}`);
    }
  } catch (e) {
    console.error(
      colors.yellow(
        `! could not open browser automatically (${
          (e as Error).message
        }). Open this URL manually:\n  ${url}`,
      ),
    );
  }
}

async function pressEnter(message: string): Promise<void> {
  await Deno.stdout.write(new TextEncoder().encode(`${message} `));
  if (!Deno.stdin.isTerminal()) return;
  const buf = new Uint8Array(64);
  await Deno.stdin.read(buf);
}

export async function listOAuthProviders(
  client: ApiClient,
): Promise<Array<{ id: string; name?: string }>> {
  const res = await apiFetch<ProvidersResponse>(
    client,
    `/connections/oauth/providers`,
  );
  return res.providers ?? [];
}

async function findConnectionByName(
  client: ApiClient,
  name: string,
  createdAfterIso: string,
): Promise<ConnectionRow | null> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set('where[name][$eq]', name);
  params.set('where[createdAt][$gt]', createdAfterIso);
  params.set('options[limit]', '1');
  const res = await apiFetch<ConnectionListResponse>(
    client,
    `/connections?${params.toString()}`,
  );
  return res.data?.[0] ?? null;
}

export interface OAuthSubflowOptions {
  providerId: string;
  connectionName: string;
  client: ApiClient;
  /** Re-auth an existing connection rather than creating a new one. */
  connectionId?: string;
}

export async function runOAuthSubflow(
  opts: OAuthSubflowOptions,
): Promise<ConnectionRow> {
  const startedAtIso = new Date().toISOString();
  const params = new URLSearchParams();
  params.set('connectionName', opts.connectionName);
  if (opts.connectionId) params.set('connectionId', opts.connectionId);
  const authorizeUrl = `${opts.client.apiUrl}/connections/oauth/${
    encodeURIComponent(opts.providerId)
  }/authorize?${params.toString()}`;

  console.error('');
  console.error(
    colors.yellow(
      '! OAuth browser handoff: you must already be signed into the QuickFlo web UI in your default browser as the same account.',
    ),
  );
  console.error(
    colors.dim(
      `  (the /authorize endpoint is session-cookie-authenticated — the CLI's access token alone isn't enough until the platform adds a CLI redirect_uri allowlist)`,
    ),
  );
  console.error('');
  await pressEnter("Press Enter when you're ready to open the browser...");

  console.error('');
  console.error(`Opening ${colors.bold(authorizeUrl)}`);
  await openBrowser(authorizeUrl);

  console.error('');
  console.error(
    colors.dim(
      `Waiting for connection "${opts.connectionName}" to appear (up to 5 minutes)...`,
    ),
  );
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = opts.connectionId
      ? await fetchById(opts.client, opts.connectionId, startedAtIso)
      : await findConnectionByName(opts.client, opts.connectionName, startedAtIso);
    if (match) return match;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out after 5 minutes waiting for OAuth completion. Re-run \`quickflo connections create --type ${opts.providerId} --name "${opts.connectionName}"\` once you've finished the browser flow, or check the QuickFlo UI to see if the connection was created.`,
  );
}

async function fetchById(
  client: ApiClient,
  id: string,
  updatedAfterIso: string,
): Promise<ConnectionRow | null> {
  try {
    const row = await apiFetch<ConnectionRow & { updatedAt?: string }>(
      client,
      `/connections/${id}`,
    );
    // For re-auth: the row already exists; treat it as ready once its
    // updatedAt has bumped past the flow-start time.
    if (row.updatedAt && row.updatedAt > updatedAfterIso) return row;
    return null;
  } catch {
    return null;
  }
}
