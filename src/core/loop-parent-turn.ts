/**
 * Tracks whether a Loop *parent* Agim turn is in-flight for a thread.
 *
 * Used so idle VERIFY reapers (`maybeReapIdleLoopVerify`) do not race a live
 * parent that is about to call `loop_verdict` after Subagent join.
 *
 * Key: platform__channel__thread (same shape as Loop sessionKey).
 */

function key(platform: string, channelId: string, threadId: string): string {
  return `${platform || ''}__${channelId || ''}__${threadId || ''}`
}

const activeParentTurns = new Set<string>()

/** Mark parent turn active (depth=0 Loop orchestrator only). */
export function markLoopParentTurnActive(
  platform: string,
  channelId: string,
  threadId: string,
): void {
  if (!platform || !threadId) return
  activeParentTurns.add(key(platform, channelId, threadId))
}

export function clearLoopParentTurnActive(
  platform: string,
  channelId: string,
  threadId: string,
): void {
  if (!platform || !threadId) return
  activeParentTurns.delete(key(platform, channelId, threadId))
}

export function isLoopParentTurnActive(
  platform: string,
  channelId: string,
  threadId: string,
): boolean {
  if (!platform || !threadId) return false
  return activeParentTurns.has(key(platform, channelId, threadId))
}

/** Test-only. */
export function _resetLoopParentTurnsForTests(): void {
  activeParentTurns.clear()
}
