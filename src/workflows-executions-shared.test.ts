import { assertEquals, assertThrows } from '@std/assert';
import { BULK_CHUNK_SIZE, chunk, parseDuration } from './workflows-executions-shared.ts';
import { UserError } from './errors.ts';

Deno.test('parseDuration: seconds → ms', () => {
  assertEquals(parseDuration('30s'), 30_000);
  assertEquals(parseDuration('1s'), 1_000);
});

Deno.test('parseDuration: minutes → ms', () => {
  assertEquals(parseDuration('5m'), 5 * 60_000);
});

Deno.test('parseDuration: hours → ms', () => {
  assertEquals(parseDuration('2h'), 2 * 3_600_000);
});

Deno.test('parseDuration: days → ms', () => {
  assertEquals(parseDuration('1d'), 86_400_000);
});

Deno.test('parseDuration: whitespace + uppercase tolerated', () => {
  assertEquals(parseDuration(' 1H '), 3_600_000);
});

Deno.test('parseDuration: invalid input throws UserError', () => {
  assertThrows(() => parseDuration('forever'), UserError);
  assertThrows(() => parseDuration('30'), UserError);
  assertThrows(() => parseDuration('1y'), UserError);
});

Deno.test('chunk: even split', () => {
  assertEquals(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

Deno.test('chunk: trailing partial batch', () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

Deno.test('chunk: empty input → empty output', () => {
  assertEquals(chunk([], 100), []);
});

Deno.test('chunk: respects BULK_CHUNK_SIZE for big lists', () => {
  const ids = Array.from({ length: BULK_CHUNK_SIZE + 1 }, (_, i) => `id-${i}`);
  const batches = chunk(ids, BULK_CHUNK_SIZE);
  assertEquals(batches.length, 2);
  assertEquals(batches[0].length, BULK_CHUNK_SIZE);
  assertEquals(batches[1].length, 1);
});

Deno.test('chunk: invalid size throws', () => {
  assertThrows(() => chunk([1, 2], 0));
  assertThrows(() => chunk([1, 2], -1));
});
