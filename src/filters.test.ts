import { assertEquals, assertThrows } from '@std/assert';
import { applySearchAttributeFilters, parseAttrExpr } from './filters.ts';

Deno.test('parseAttrExpr: explicit ops map to value prefixes', () => {
  assertEquals(parseAttrExpr('return.body.operation:eq:DELETE'), [
    'where[searchAttributes.return.body.operation]',
    '=DELETE',
  ]);
  assertEquals(parseAttrExpr('status:ne:closed'), [
    'where[searchAttributes.status]',
    '!=closed',
  ]);
  assertEquals(parseAttrExpr('note:contains:urgent'), [
    'where[searchAttributes.note]',
    'urgent',
  ]);
  assertEquals(parseAttrExpr('note:ncontains:spam'), [
    'where[searchAttributes.note]',
    '!spam',
  ]);
});

Deno.test('parseAttrExpr: shorthand <path>:<value> defaults to exact (eq)', () => {
  assertEquals(parseAttrExpr('return.statusCode:202'), [
    'where[searchAttributes.return.statusCode]',
    '=202',
  ]);
});

Deno.test('parseAttrExpr: unrecognized middle token is part of the value', () => {
  // `2026-01-01:00:00` is a value, not an op — keep the colons.
  assertEquals(parseAttrExpr('startedLabel:2026-01-01:00:00'), [
    'where[searchAttributes.startedLabel]',
    '=2026-01-01:00:00',
  ]);
});

Deno.test('parseAttrExpr: * path routes to broad operators (any field)', () => {
  // bare / eq / contains → $containsValue with the raw term (no prefix)
  assertEquals(parseAttrExpr('*:DELETE'), [
    'where[searchAttributes][$containsValue]',
    'DELETE',
  ]);
  assertEquals(parseAttrExpr('*:contains:DELETE'), [
    'where[searchAttributes][$containsValue]',
    'DELETE',
  ]);
  // ne / ncontains → $notContainsValue
  assertEquals(parseAttrExpr('*:ncontains:spam'), [
    'where[searchAttributes][$notContainsValue]',
    'spam',
  ]);
  assertEquals(parseAttrExpr('*:ne:spam'), [
    'where[searchAttributes][$notContainsValue]',
    'spam',
  ]);
});

Deno.test('parseAttrExpr: rejects missing colon / empty path', () => {
  assertThrows(() => parseAttrExpr('justapath'));
  assertThrows(() => parseAttrExpr(':eq:x'));
});

Deno.test('applySearchAttributeFilters: appends attrs + containsValue', () => {
  const params = new URLSearchParams();
  applySearchAttributeFilters(
    params,
    ['return.body.operation:eq:DELETE', 'return.statusCode:202'],
    'Lead',
  );
  assertEquals(
    params.get('where[searchAttributes.return.body.operation]'),
    '=DELETE',
  );
  assertEquals(
    params.get('where[searchAttributes.return.statusCode]'),
    '=202',
  );
  assertEquals(params.get('where[searchAttributes][$containsValue]'), 'Lead');
});
