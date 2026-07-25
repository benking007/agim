/**
 * Loop parent wait gate — after this round has dispatched, the parent must
 * only wait (and then call loop_verdict). No research / mutation / extra
 * dispatch until verification completes. After verdict, parent may summarize
 * or do follow-up research.
 *
 * Shares AGIM_LOOP_DISPATCH_GATE opt-out (same family of Loop hard gates).
 */

import { canonicalizeToolName, expandToolNameList } from './llm/tool-names.js'
import { countRoundLiveSubagents, getActiveLoop } from './loop-run.js'
import { isLoopDispatchGateOn } from './loop-dispatch-gate.js'

/** Tools allowed while waiting on round children or for loop_verdict. */
const WAIT_ONLY_BASE: readonly string[] = [
  'agim_echo',
  'agim_now',
  'agim_random_uuid',
  'agim_sleep_ms',
  'mcp__agim__loop_verdict',
]

const WAIT_ONLY = expandToolNameList(WAIT_ONLY_BASE)

function isWaitOnlyTool(toolName: string): boolean {
  if (!toolName) return false
  if (WAIT_ONLY.has(toolName)) return true
  const canon = canonicalizeToolName(toolName)
  if (WAIT_ONLY.has(canon)) return true
  if (toolName.startsWith('mcp__agim__')) {
    const bare = toolName.slice('mcp__agim__'.length)
    if (WAIT_ONLY.has(bare) || WAIT_ONLY.has(`mcp__agim__${bare}`)) return true
  }
  const lower = toolName.toLowerCase()
  return (
    lower === 'loop_verdict'
    || lower === 'agim_sleep_ms'
    || lower === 'sleep_ms'
    || lower === 'agim_now'
    || lower === 'agim_echo'
    || lower === 'agim_random_uuid'
  )
}

function isLoopVerdictTool(toolName: string): boolean {
  const lower = (toolName || '').toLowerCase()
  return lower === 'loop_verdict' || lower.endsWith('__loop_verdict')
}

export type LoopParentWaitGateResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * After ≥1 dispatch this round (status still in dispatch/verify), or while
 * pending_user_confirm: parent may only wait / (when live=0) call loop_verdict.
 */
export function evaluateLoopParentWaitGate(
  platform: string,
  channelId: string,
  threadId: string,
  toolName: string,
): LoopParentWaitGateResult {
  if (!isLoopDispatchGateOn()) return { ok: true }
  if (!platform || !threadId) return { ok: true }

  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return { ok: true }
  if (run.status === 'aligning' || run.status === 'ended') return { ok: true }

  if (run.status === 'pending_user_confirm') {
    if (isLoopVerdictTool(toolName)) {
      return {
        ok: false,
        reason:
          'loop-parent-wait: pending_user_confirm — wait for Portal End/Continue; '
          + 'do not call loop_verdict again.',
      }
    }
    if (isWaitOnlyTool(toolName)) return { ok: true }
    return {
      ok: false,
      reason:
        'loop-parent-wait: pending_user_confirm — user is confirming the conclusion. '
        + 'Do not research or dispatch; wait for Portal End/Continue.',
    }
  }

  // Wait window: dispatched and still in dispatching/verifying (pre next-round planning).
  const inWaitWindow =
    (run.dispatchesThisRound || 0) >= 1
    && (
      run.status === 'dispatching'
      || run.status === 'verifying'
      || run.status === 'running'
      || run.status === 'observing'
    )
  if (!inWaitWindow) return { ok: true }

  const live = countRoundLiveSubagents(run)

  if (isWaitOnlyTool(toolName)) {
    if (live > 0 && isLoopVerdictTool(toolName)) {
      return {
        ok: false,
        reason:
          'loop-parent-wait: this round still has live Subagents — wait until '
          + 'liveSubagents=0 before loop_verdict.',
      }
    }
    return { ok: true }
  }

  return {
    ok: false,
    reason:
      'loop-parent-wait: after dispatch this round, parent must ONLY wait '
      + '(agim_sleep_ms / agim_now) then call mcp__agim__loop_verdict — '
      + 'no research, mutation, or further call_agent(s) until verification. '
      + 'After verdict you may summarize or do follow-up research. '
      + 'Set AGIM_LOOP_DISPATCH_GATE=off to disable.',
  }
}
