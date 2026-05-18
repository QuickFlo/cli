/**
 * Stable exit codes for the CLI. Documented in EXIT_CODES.md at the repo root.
 * CI scripts and agents depend on these — change with care.
 */

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_SERVER_ERROR = 2;
export const EXIT_VALIDATION = 3;
export const EXIT_TIMEOUT = 124;
export const EXIT_INTERRUPTED = 130;
