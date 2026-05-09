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
 * Resolve a user-supplied org identifier (SUID or UUID) to the full org
 * record. RBAC on the backend already restricts the result to orgs the user
 * belongs to, so a missing match means either wrong value or no access.
 */
export async function resolveOrganization(
  opts: { apiUrl: string; accessToken: string },
  input: string,
): Promise<ResolvedOrg> {
  const key = UUID_RE.test(input) ? 'id' : 'suid';
  const params = new URLSearchParams();
  params.set(`where[${key}][$eq]`, input);
  params.set('options[limit]', '1');
  const res = await fetch(
    `${opts.apiUrl}/organizations?${params.toString()}`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.accessToken}`,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Org lookup failed (${res.status}): ${text || res.statusText}`,
    );
  }
  const body = (await res.json()) as { data?: ResolvedOrg[] };
  const match = body.data?.[0];
  if (!match) {
    throw new Error(
      `No organization found with ${key}="${input}" (or you don't have access).`,
    );
  }
  return match;
}
