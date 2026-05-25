import { assertEquals, assertStringIncludes } from '@std/assert';
import { buildLookupKey, encodeStripeForm, injectProductId } from './microapp-stripe-sync.ts';

Deno.test('encodeStripeForm flattens nested objects into bracket notation', () => {
  const encoded = encodeStripeForm({
    product: 'prod_123',
    unit_amount: 4900,
    recurring: { interval: 'month' },
    metadata: { qf_tier: 'pro' },
  });
  const parts = encoded.split('&').sort();
  assertEquals(parts, [
    'metadata%5Bqf_tier%5D=pro',
    'product=prod_123',
    'recurring%5Binterval%5D=month',
    'unit_amount=4900',
  ]);
});

Deno.test('encodeStripeForm encodes array lookup_keys with indices', () => {
  const encoded = encodeStripeForm({ 'lookup_keys[]': ['a_pro_month'] });
  // The bracket key itself is encoded; the index suffix is appended.
  assertStringIncludes(encoded, 'lookup_keys');
  assertStringIncludes(encoded, 'a_pro_month');
});

Deno.test('encodeStripeForm skips null and undefined', () => {
  const encoded = encodeStripeForm({ a: 1, b: null, c: undefined });
  assertEquals(encoded, 'a=1');
});

Deno.test('buildLookupKey is deterministic and namespaced', () => {
  assertEquals(buildLookupKey('acme-portal', 'pro', 'month'), 'acme-portal_pro_month');
});

Deno.test('injectProductId rewrites an empty stripeProductIds array', () => {
  const snippet = '  stripeProductIds: [],\n';
  assertEquals(injectProductId(snippet, 'prod_abc'), "  stripeProductIds: ['prod_abc'],\n");
});

Deno.test('injectProductId overwrites an already-populated array', () => {
  const snippet = "stripeProductIds: ['prod_old'],";
  assertEquals(injectProductId(snippet, 'prod_new'), "stripeProductIds: ['prod_new'],");
});

Deno.test('injectProductId leaves snippets without the line untouched', () => {
  const snippet = 'no stripe line here';
  assertEquals(injectProductId(snippet, 'prod_abc'), 'no stripe line here');
});
