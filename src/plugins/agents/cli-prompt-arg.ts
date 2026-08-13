/**
 * Agent CLIs that take the user prompt as a trailing positional will treat
 * a prompt starting with `-` as a flag (e.g. `--dangerously-skip-permissions`).
 * Always terminate options with `--` before the prompt so user text cannot
 * be parsed as a CLI switch.
 */

/** Append the user prompt after a `--` options terminator. */
export function pushPromptArg(args: string[], prompt: string): void {
  args.push('--', prompt)
}

/**
 * Remove the trailing prompt (and its `--` terminator if present) so
 * callers can insert flags before the positional.
 */
export function takeTrailingPrompt(args: string[]): string {
  const prompt = args.pop() ?? ''
  if (args[args.length - 1] === '--') args.pop()
  return prompt
}
