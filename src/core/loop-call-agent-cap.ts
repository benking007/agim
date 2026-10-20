/**
 * Loop × per-turn call_agent cap — avoid dispatch-gate deadlock.
 *
 * Turn budget (`AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN`, default 12) is shared
 * across the whole user turn. Loop `continue|revise` advances rounds inside
 * that same turn; if history is not cleared, R2 cannot `call_agents` while
 * dispatch-gate also forbids parent research → hard deadlock.
 *
 * Primary reset: loop_verdict continue/revise in agim-dispatcher.
 * Belt-and-suspenders: clear history again on the first dispatch of a new
 * Loop round (planning/reflecting + dispatchesThisRound===0).
 */

export function shouldClearCallAgentHistoryForLoopRound(run: {
  status: string
  dispatchesThisRound?: number
} | null | undefined): boolean {
  if (!run) return false
  if (
    run.status === 'aligning'
    || run.status === 'ended'
    || run.status === 'pending_user_confirm'
  ) {
    return false
  }
  if ((run.dispatchesThisRound || 0) !== 0) return false
  // New round ready to plan/dispatch — never let stale turn history block.
  return run.status === 'planning' || run.status === 'reflecting'
}
