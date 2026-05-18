/**
 * Shared ref-parsing utilities for resource lookup commands. Every CLI
 * surface that accepts a `<ref>` string disambiguates the same way:
 *   - full UUID → `id`
 *   - otherwise → `name`
 *
 * Callers that need a different lookup (e.g. `--by suid`) pass it
 * explicitly via the cliffy `--by` flag, which threads through to
 * `where[${lookup}][$eq]`. Auto-detection deliberately does not guess
 * SUIDs — short refs like `prod` are names, not SUIDs.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Lookup = 'id' | 'suid' | 'name';

export function detectLookup(ref: string): Lookup {
  return UUID_RE.test(ref) ? 'id' : 'name';
}
