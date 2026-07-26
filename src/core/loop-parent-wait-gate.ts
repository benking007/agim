/**
 * Loop parent wait gate — after this round has dispatched, the *parent*
 * must only wait (then ask_user when uncertain / loop_verdict). No research /
 * mutation / extra dispatch until verification completes. After verdict,
 * parent may summarize or do follow-up research.
 *
 * Parent-only: callers must skip this gate when callDepth > 0 (Subagents
 * share the parent threadId and must keep research tools).
 *
 * Shares AGIM_LOOP_DISPATCH_GATE opt-out (same family of Loop hard gates).
 */

import { canonicalizeToolName, expandToolNameList } from './llm/tool-names.js'
import { countRoundLiveSubagents, getActiveLoop } from './loop-run.js'
import { isLoopDispatchGateOn } from './loop-dispatch-gate.js'

/** Always-safe wait tools (no HITL, no verdict). */
const WAIT_IDLE_BASE: readonly string[] = [
  'agim_echo',
  'agim_now',
  'agim_random_uuid',
  'agim_sleep_ms',
]

/** Allowed after children settle (mid-review HITL + verdict). */
const WAIT_VERIFY_BASE: readonly string[] = [
  ...WAIT_IDLE_BASE,
  'mcp__agim__ask_user',
  'mcp__agim__loop_verdict',
]

const WAIT_IDLE = expandToolNameList(WAIT_IDLE_BASE)
const WAIT_VERIFY = expandToolNameList(WAIT_VERIFY_BASE)

function toolInSet(toolName: string, set: Set<string>): boolean {
  if (!toolName) return false
  if (set.has(toolName)) return true
  const canon = canonicalizeToolName(toolName)
  if (set.has(canon)) return true
  if (toolName.startsWith('mcp__agim__')) {
    const bare = toolName.slice('mcp__agim__'.length)
    if (set.has(bare) || set.has(`mcp__agim__${bare}`)) return true
  }
  return false
}

function isWaitIdleTool(toolName: string): boolean {
  if (toolInSet(toolName, WAIT_IDLE)) return true
  const lower = toolName.toLowerCase()
  return (
    lower === 'agim_sleep_ms'
    || lower === 'sleep_ms'
    || lower === 'agim_now'
    || lower === 'agim_echo'
    || lower === 'agim_random_uuid'
  )
}

function isWaitVerifyTool(toolName: string): boolean {
  if (isWaitIdleTool(toolName)) return true
  if (toolInSet(toolName, WAIT_VERIFY)) return true
  const lower = toolName.toLowerCase()
  return lower === 'loop_verdict' || lower === 'ask_user'
}

function isLoopVerdictTool(toolName: string): boolean {
  const lower = (toolName || '').toLowerCase()
  return lower === 'loop_verdict' || lower.endsWith('__loop_verdict')
}

function isAskUserTool(toolName: string): boolean {
  const lower = (toolName || '').toLowerCase()
  return lower === 'ask_user' || lower.endsWith('__ask_user')
}

export type LoopParentWaitGateResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * After ≥1 dispatch this round (status still in dispatch/verify), or while
 * pending_user_confirm: parent may only wait; when live=0 also ask_user /
 * loop_verdict. Do not call ask_user to "unblock" live Subagents.
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
    if (isLoopVerdictTool(toolName) || isAskUserTool(toolName)) {
      return {
        ok: false,
        reason:
          'loop-parent-wait: pending_user_confirm — wait for Portal End/Continue; '
          + 'do not call loop_verdict / ask_user again.',
      }
    }
    if (isWaitIdleTool(toolName)) return { ok: true }
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

  if (live > 0) {
    if (isWaitIdleTool(toolName)) return { ok: true }
    if (isLoopVerdictTool(toolName) || isAskUserTool(toolName)) {
      return {
        ok: false,
        reason:
          'loop-parent-wait: this round still has live Subagents — only wait '
          + '(agim_sleep_ms / agim_now). Do NOT ask_user to unblock; do NOT call '
          + 'loop_verdict until liveSubagents=0.',
      }
    }
    return {
      ok: false,
      reason:
        'loop-parent-wait: live Subagents still running — parent must ONLY wait '
        + '(agim_sleep_ms / agim_now). No research, ask_user, loop_verdict, or '
        + 'further call_agent(s) until liveSubagents=0. '
        + 'Set AGIM_LOOP_DISPATCH_GATE=off to disable.',
    }
  }

  // live === 0: mid-review — wait / ask_user / loop_verdict
  if (isWaitVerifyTool(toolName)) return { ok: true }

  return {
    ok: false,
    reason:
      'loop-parent-wait: after dispatch this round, parent must ONLY wait '
      + '(agim_sleep_ms / agim_now), optionally mcp__agim__ask_user on '
      + 'uncertain/anomalous results, then call mcp__agim__loop_verdict — '
      + 'no research, mutation, or further call_agent(s) until verification. '
      + 'A second call_agents in the same round is refused; use decision='
      + 'continue|revise to open the next round (resets per-turn call_agent cap). '
      + '下一步：先 mcp__agim__loop_verdict（continue|revise），勿同轮再派工。 '
      + 'Set AGIM_LOOP_DISPATCH_GATE=off to disable.',
  }
}
