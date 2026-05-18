import { assertEquals } from '@std/assert';
import {
  ApiError,
  exitCodeFor,
  TimeoutError,
  toErrorJson,
  UserError,
  ValidationError,
} from './errors.ts';
import { EXIT_SERVER_ERROR, EXIT_TIMEOUT, EXIT_USER_ERROR, EXIT_VALIDATION } from './exit-codes.ts';

Deno.test('exitCodeFor: ValidationError → EXIT_VALIDATION', () => {
  assertEquals(exitCodeFor(new ValidationError('x')), EXIT_VALIDATION);
});

Deno.test('exitCodeFor: UserError → EXIT_USER_ERROR', () => {
  assertEquals(exitCodeFor(new UserError('x')), EXIT_USER_ERROR);
});

Deno.test('exitCodeFor: TimeoutError → EXIT_TIMEOUT', () => {
  assertEquals(exitCodeFor(new TimeoutError('x')), EXIT_TIMEOUT);
});

Deno.test('exitCodeFor: ApiError 4xx → EXIT_USER_ERROR', () => {
  assertEquals(exitCodeFor(new ApiError(404, '/foo', 'not found')), EXIT_USER_ERROR);
});

Deno.test('exitCodeFor: ApiError 5xx → EXIT_SERVER_ERROR', () => {
  assertEquals(exitCodeFor(new ApiError(502, '/foo', 'bad gateway')), EXIT_SERVER_ERROR);
});

Deno.test('exitCodeFor: unknown → EXIT_USER_ERROR', () => {
  assertEquals(exitCodeFor(new Error('x')), EXIT_USER_ERROR);
});

Deno.test('toErrorJson: ApiError includes status + path + code', () => {
  const err = new ApiError(404, '/workflows/abc', 'API 404 /workflows/abc: not found', {
    code: 'not_found',
  });
  const json = toErrorJson(err);
  assertEquals(json.error.status, 404);
  assertEquals(json.error.path, '/workflows/abc');
  assertEquals(json.error.code, 'not_found');
});

Deno.test('toErrorJson: ValidationError defaults code', () => {
  const json = toErrorJson(new ValidationError('bad shape'));
  assertEquals(json.error.code, 'validation_error');
  assertEquals(json.error.message, 'bad shape');
});

Deno.test('toErrorJson: ApiError without code → http_<status>', () => {
  const json = toErrorJson(new ApiError(503, '/x', 'down'));
  assertEquals(json.error.code, 'http_503');
});
