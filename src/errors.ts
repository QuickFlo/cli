/**
 * Typed errors + a renderer that respects the -j JSON contract.
 * apiFetch (api.ts) throws ApiError on non-2xx; commands can throw
 * UserError or ValidationError to map to specific exit codes without
 * the top-level catch needing to parse strings.
 */

import {
  EXIT_INTERRUPTED,
  EXIT_SERVER_ERROR,
  EXIT_TIMEOUT,
  EXIT_USER_ERROR,
  EXIT_VALIDATION,
} from './exit-codes.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly path: string;
  constructor(
    status: number,
    path: string,
    message: string,
    opts: { code?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.code = opts.code;
    this.details = opts.details;
  }
}

export class UserError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  constructor(message: string, opts: { code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'UserError';
    this.code = opts.code;
    this.details = opts.details;
  }
}

export class ValidationError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  constructor(message: string, opts: { code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = opts.code;
    this.details = opts.details;
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof ValidationError) return EXIT_VALIDATION;
  if (err instanceof UserError) return EXIT_USER_ERROR;
  if (err instanceof TimeoutError) return EXIT_TIMEOUT;
  if (err instanceof ApiError) {
    if (err.status >= 500) return EXIT_SERVER_ERROR;
    return EXIT_USER_ERROR;
  }
  if (err instanceof Deno.errors.Interrupted) return EXIT_INTERRUPTED;
  return EXIT_USER_ERROR;
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    status?: number;
    path?: string;
    details?: unknown;
  };
}

export function toErrorJson(err: unknown): ErrorJson {
  if (err instanceof ApiError) {
    return {
      error: {
        code: err.code ?? `http_${err.status}`,
        message: err.message,
        status: err.status,
        path: err.path,
        details: err.details,
      },
    };
  }
  if (err instanceof ValidationError) {
    return {
      error: { code: err.code ?? 'validation_error', message: err.message, details: err.details },
    };
  }
  if (err instanceof UserError) {
    return {
      error: { code: err.code ?? 'user_error', message: err.message, details: err.details },
    };
  }
  if (err instanceof TimeoutError) {
    return { error: { code: 'timeout', message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: 'unknown_error', message } };
}

/**
 * Render an error to stderr in either human or JSON shape, then return the
 * exit code the process should use. The top-level catch in mod.ts calls this.
 */
export function printError(err: unknown, json: boolean): number {
  if (json) {
    console.error(JSON.stringify(toErrorJson(err)));
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    if (err instanceof ApiError && err.details && typeof err.details === 'string') {
      console.error(err.details);
    }
  }
  return exitCodeFor(err);
}
