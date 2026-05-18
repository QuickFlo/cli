/**
 * Progress / info logging that respects --quiet. Errors always print.
 * All log output goes to stderr so stdout stays pipe-clean for -j callers.
 */

let quiet = false;

export function setQuiet(v: boolean): void {
  quiet = v;
}

export function isQuiet(): boolean {
  return quiet;
}

export function info(...args: unknown[]): void {
  if (quiet) return;
  console.error(...args);
}

export function warn(...args: unknown[]): void {
  if (quiet) return;
  console.error(...args);
}

export function error(...args: unknown[]): void {
  console.error(...args);
}
