import { assertEquals } from '@std/assert';
import { detectLookup } from './refs.ts';

Deno.test('detectLookup: UUID → id', () => {
  assertEquals(detectLookup('11111111-2222-3333-4444-555555555555'), 'id');
});

Deno.test('detectLookup: short alphanumeric ref → name (not suid)', () => {
  // Regression: `prod` / `abcd` used to auto-detect as suid, breaking
  // every name-based lookup (environments, connections, workflows, …).
  assertEquals(detectLookup('prod'), 'name');
  assertEquals(detectLookup('abcd'), 'name');
});

Deno.test('detectLookup: long or symbol-bearing ref → name', () => {
  assertEquals(detectLookup('my workflow'), 'name');
  assertEquals(detectLookup('production-env'), 'name');
  assertEquals(detectLookup('abcdefghi'), 'name');
});

Deno.test('detectLookup: non-canonical UUID-ish strings → name', () => {
  // Slightly-off UUIDs are names, not ids.
  assertEquals(detectLookup('11111111-2222-3333-4444-55555555555'), 'name'); // one short
  assertEquals(detectLookup('not-a-uuid'), 'name');
});
