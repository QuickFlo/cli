import { assertEquals, assertThrows } from '@std/assert';
import { canonicalizeSlug } from './packages-publish.ts';

Deno.test('canonicalizeSlug: bare name gets @<orgSuid>/ prefix', () => {
  assertEquals(canonicalizeSlug('lead-gen', 'quickflo'), '@quickflo/lead-gen');
});

Deno.test('canonicalizeSlug: already-canonical slug passes through', () => {
  assertEquals(
    canonicalizeSlug('@quickflo/lead-gen', 'quickflo'),
    '@quickflo/lead-gen',
  );
});

Deno.test('canonicalizeSlug: scoped slug with unknown org suid passes through', () => {
  assertEquals(
    canonicalizeSlug('@quickflo/lead-gen', undefined),
    '@quickflo/lead-gen',
  );
});

Deno.test('canonicalizeSlug: scoped slug for a different org throws with the canonical form', () => {
  assertThrows(
    () => canonicalizeSlug('@other/lead-gen', 'quickflo'),
    Error,
    '@quickflo/lead-gen',
  );
});

Deno.test('canonicalizeSlug: bare name without an org suid throws', () => {
  assertThrows(
    () => canonicalizeSlug('lead-gen', undefined),
    Error,
    'canonical slug',
  );
});

Deno.test('canonicalizeSlug: malformed scoped slugs throw', () => {
  assertThrows(() => canonicalizeSlug('@quickflo', 'quickflo'), Error);
  assertThrows(() => canonicalizeSlug('@/lead-gen', 'quickflo'), Error);
  assertThrows(() => canonicalizeSlug('@quickflo/a/b', 'quickflo'), Error);
  assertThrows(() => canonicalizeSlug('@quickflo/', 'quickflo'), Error);
});
