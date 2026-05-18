/**
 * Shared ref-parsing utilities for resource lookup commands (`get`, `pull`,
 * lifecycle verbs). Every CLI surface that accepts a user-supplied
 * `<ref>` string disambiguates the same way: full UUID → `id`, short
 * alphanumeric → `suid`, otherwise treat as `name`. Keep the grammar in one
 * place so it can't drift between commands.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Lookup = 'id' | 'suid' | 'name';

export function detectLookup(ref: string): Lookup {
  if (UUID_RE.test(ref)) return 'id';
  if (/^[a-z0-9]{3,8}$/i.test(ref)) return 'suid';
  return 'name';
}
