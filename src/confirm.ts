/**
 * Backwards-compatible alias for the shared confirm() helper in tty.ts.
 * Existing commands import `confirmDestructive` — keep that name working
 * while the behavior follows the non-interactive contract (auto-yes when
 * stdin is not a TTY).
 */

export { confirm as confirmDestructive } from './tty.ts';
