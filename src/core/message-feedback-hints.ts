// Consume-once ephemeral hint after a thumbs-down.
//
// Injected via AgentSendOpts.ephemeralContext (same path as persona / goal
// snippets) — never written into durable session JSONL.

const pendingDownvoteHints = new Map<string, string>()

export const DOWNVOTE_HINT_TEMPLATE = [
  '[operator feedback — previous reply rated unhelpful]',
  'The user marked your previous assistant reply as unhelpful.',
  'Prefer correcting that approach rather than repeating it.',
  'If it is unclear what failed, ask one brief clarifying question.',
].join(' ')

export function feedbackThreadKey(
  platform: string,
  channelId: string,
  threadId: string,
): string {
  return `${platform}:${channelId}:${threadId}`
}

/** Arm (or refresh) the next-turn soft steer for a downvote. */
export function setPendingDownvoteHint(threadKey: string, hint = DOWNVOTE_HINT_TEMPLATE): void {
  const key = threadKey.trim()
  if (!key) return
  pendingDownvoteHints.set(key, hint)
}

/** Clear when the user switches to upvote or clears the vote. */
export function clearPendingDownvoteHint(threadKey: string): void {
  pendingDownvoteHints.delete(threadKey.trim())
}

/** Read + delete. Empty / missing → undefined. */
export function consumePendingDownvoteHint(threadKey: string): string | undefined {
  const key = threadKey.trim()
  if (!key) return undefined
  const hint = pendingDownvoteHints.get(key)
  if (hint === undefined) return undefined
  pendingDownvoteHints.delete(key)
  return hint
}

/** Test helper. */
export function resetPendingDownvoteHints(): void {
  pendingDownvoteHints.clear()
}
