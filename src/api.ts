/**
 * Thin REST client for the QuickFlo API. Every command takes an `ApiClient`
 * so the wire-level concerns (auth header, org scoping, error shape) live in
 * one place.
 */

export interface ApiClient {
  apiUrl: string;
  accessToken: string;
  orgId: string;
}

export async function apiFetch<T>(
  client: ApiClient,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${client.accessToken}`,
    'x-organization-id': client.orgId,
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${client.apiUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${path}: ${text || res.statusText}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export interface ResolvedOrg {
  id: string;
  suid?: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a user-supplied org identifier (SUID or UUID) against the orgs the
 * caller can access. We use the /auth/me response (passed in) instead of
 * querying /organizations directly because /organizations is UserGuard-only —
 * PATs can't hit it, but they can hit /auth/me. The auth/me response already
 * contains every org the caller can access, so the lookup is just a
 * client-side filter.
 */
export function resolveOrganization(
  organizations: ResolvedOrg[],
  input: string,
): ResolvedOrg {
  const key = UUID_RE.test(input) ? 'id' : 'suid';
  const match = organizations.find((o) => o[key] === input);
  if (!match) {
    throw new Error(
      `No organization found with ${key}="${input}" (or you don't have access).`,
    );
  }
  return match;
}
