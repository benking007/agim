/**
 * Loop VERIFY hard gate (R4).
 *
 * After a round has ≥1 dispatch, the parent must call mcp__agim__loop_verdict
 * before the turn can end as a normal user-facing answer. Soft prompt alone
 * was ignored in production (report delivered while 验收 stayed 0).
 *
 * Opt out: AGIM_LOOP_VERIFY_GATE=off|0|false|no|disable
 */

import { getActiveLoop, getLoopUxBucket, threadHasLiveSubagents } from './loop-run.js'

/** Default ON when a Loop round is waiting on structured verification. */
export function isLoopVerifyGateOn(): boolean {
  const raw = (process.env.AGIM_LOOP_VERIFY_GATE ?? '').toLowerCase().trim()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no' || raw === 'disable')
}

function isLoopVerdictTool(toolName: string): boolean {
  const n = (toolName || '').toLowerCase()
  return n === 'loop_verdict' || n.endsWith('__loop_verdict')
}

/**
 * True when an active Loop has dispatched this round and still awaits verdict.
 * HARD: false while any Subagent is still pending/running — do not start evaluation.
 */
export function loopNeedsVerdict(
  platform: string,
  channelId: string,
  threadId: string,
): boolean {
  if (!isLoopVerifyGateOn()) return false
  if (!platform || !threadId) return false
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return false
  if (run.status === 'aligning' || run.status === 'ended') return false
  if ((run.dispatchesThisRound || 0) < 1) return false
  if (threadHasLiveSubagents(platform, channelId, threadId)) return false
  return getLoopUxBucket(run) === 'verify'
}

export function isLoopVerdictToolName(toolName: string): boolean {
  return isLoopVerdictTool(toolName)
}

export function loopVerifySteerText(): string {
  return [
    '[loop steer — VERIFY required]',
    'This Loop round already dispatched Subagents (派工≥1) but has NOT called',
    'mcp__agim__loop_verdict yet. Do NOT write a final user-facing report now.',
    'Call mcp__agim__loop_verdict with: decision, met (boolean), summary,',
    'and if unmet: gaps[] + nextDirection. met=true → decision=stop.',
    'met=false → decision=continue|revise. User can /loop stop.',
    '[/loop steer]',
  ].join('\n')
}

export function loopVerifyFollowUpPrompt(): string {
  return (
    'Loop 验收未完成：请立刻调用 mcp__agim__loop_verdict，'
    + '对照目标给出 met / summary（未达标则 gaps + nextDirection）。'
    + '不要再写长文报告；验收工具成功后再结束。'
  )
}
