import { assertEquals, assertStringIncludes } from '@std/assert';
import {
  buildLookupKey,
  encodeStripeForm,
  injectProductId,
  priceEnvVar,
  upsertEnvPrices,
} from './microapp-stripe-sync.ts';

const PRICES = [
  { tier: 'pro', interval: 'month', priceId: 'price_m', lookupKey: 'a_pro_month' },
  { tier: 'pro', interval: 'year', priceId: 'price_y', lookupKey: 'a_pro_year' },
];

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

Deno.test('priceEnvVar normalizes tier + interval', () => {
  assertEquals(priceEnvVar('pro', 'month'), 'VITE_QF_PRICE_PRO_MONTH');
  assertEquals(priceEnvVar('pro-plus', 'year'), 'VITE_QF_PRICE_PRO_PLUS_YEAR');
});

Deno.test('upsertEnvPrices appends a managed block to existing env', () => {
  const env = 'VITE_QF_APP_ID=acme\n';
  const out = upsertEnvPrices(env, PRICES);
  assertStringIncludes(out, 'VITE_QF_APP_ID=acme');
  assertStringIncludes(out, 'VITE_QF_PRICE_PRO_MONTH=price_m');
  assertStringIncludes(out, 'VITE_QF_PRICE_PRO_YEAR=price_y');
  // The user's own line survives.
  assertStringIncludes(out, 'quickflo:stripe');
});

Deno.test('upsertEnvPrices replaces an existing managed block (idempotent)', () => {
  const first = upsertEnvPrices('VITE_QF_APP_ID=acme\n', PRICES);
  const updated = upsertEnvPrices(first, [
    { tier: 'pro', interval: 'month', priceId: 'price_NEW', lookupKey: 'a_pro_month' },
  ]);
  // Old price id is gone, new one present, block not duplicated.
  assertStringIncludes(updated, 'VITE_QF_PRICE_PRO_MONTH=price_NEW');
  assertEquals(updated.includes('price_m'), false);
  assertEquals(updated.split('quickflo:stripe (managed').length - 1, 1);
});

Deno.test('upsertEnvPrices handles empty env content', () => {
  const out = upsertEnvPrices('', PRICES);
  assertStringIncludes(out, 'VITE_QF_PRICE_PRO_MONTH=price_m');
});
