/**
 * Shared confirmation prompt for destructive commands (delete, prune, etc).
 * Reads a y/N answer from stdin TTY; `--yes` callers skip the prompt. When
 * stdin is not a TTY (piped/CI) we refuse implicit consent — the user must
 * pass `--yes`.
 */

export async function confirmDestructive(
  prompt: string,
  yes: boolean | undefined,
): Promise<boolean> {
  if (yes) return true;
  if (!Deno.stdin.isTerminal()) {
    console.error(
      'Refusing to prompt: stdin is not a TTY. Re-run with --yes to confirm non-interactively.',
    );
    return false;
  }
  await Deno.stdout.write(new TextEncoder().encode(`${prompt} [y/N] `));
  const buf = new Uint8Array(8);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}
