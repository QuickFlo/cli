/**
 * TTY detection + a confirm() helper that follows the CLI's non-interactive
 * contract: when stdin is NOT a TTY (piped, CI, agent), confirms auto-succeed
 * so scripts don't hang on prompts. This matches `gh`, `npm`, and `terraform`.
 * For interactive sessions, the user still sees the y/N prompt.
 */

export function isStdinTTY(): boolean {
  return Deno.stdin.isTerminal();
}

export function isStdoutTTY(): boolean {
  return Deno.stdout.isTerminal();
}

export async function confirm(prompt: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!isStdinTTY()) return true;
  await Deno.stdout.write(new TextEncoder().encode(`${prompt} [y/N] `));
  const buf = new Uint8Array(8);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}
