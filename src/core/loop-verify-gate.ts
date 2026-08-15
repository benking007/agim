/**
 * Loop VERIFY hard gate (R4).
 *
 * After a round has ≥1 dispatch, the parent must call mcp__agim__loop_verdict
 * before the turn can end as a normal user-facing answer. Soft prompt alone
 * was ignored in production (report delivered while 验收 stayed 0).
 *
 * Opt out: AGIM_LOOP_VERIFY_GATE=off|0|false|no|disable
 */

import { threadHasPendingAsk } from './ask-user-rpc.js'
import { isLoopParentTurnActive } from './loop-parent-turn.js'
import {
  forceLoopExitSkippedVerify,
  getActiveLoop,
  getLoopUxBucket,
  threadHasLiveSubagents,
  type LoopExitEnforceResult,
} from './loop-run.js'
import { isLoopAutoVerifyEnabled } from './loop-evaluator.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'loop-verify-gate' })

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
  if (run.status === 'pending_user_confirm') return false
  if ((run.dispatchesThisRound || 0) < 1) return false
  if (threadHasLiveSubagents(platform, channelId, threadId)) return false
  // Mid-VERIFY HITL: wait for user reply before forcing loop_verdict follow-up.
  if (threadHasPendingAsk(platform, channelId, threadId)) return false
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
    'If results are uncertain, conflicting, or data looks anomalous: call',
    'mcp__agim__ask_user first; after the user replies, then call loop_verdict.',
    'Otherwise call mcp__agim__loop_verdict with: decision, met (boolean), summary,',
    'and if unmet: gaps[] + nextDirection. met=true → decision=stop.',
    'met=false → decision=continue|revise. User can /loop stop.',
    '[/loop steer]',
  ].join('\n')
}

export function loopVerifyFollowUpPrompt(): string {
  return (
    'Loop 验收未完成：若结论不确定 / 有疑问 / 数据异常，先用 mcp__agim__ask_user '
    + '向用户提问，等回复后再调用 mcp__agim__loop_verdict；'
    + '否则立刻调用 loop_verdict，对照目标给出 met / summary（未达标则 gaps + nextDirection）。'
    + '不要再写长文报告；验收工具成功后再结束。'
  )
}

/**
 * When Subagents are done but the parent turn already ended (sleep/wake,
 * abort, timeout) without `loop_verdict`, end the Loop as `verify_skipped`
 * so Portal does not show「还在继续」forever.
 *
 * With AGIM_LOOP_AUTO_VERIFY=1 (and a routeCtx available) the reaper first
 * runs a cheap auto-verify reviewer that PRODUCES the verdict the parent
 * never did; only when the reviewer is unavailable / unparseable does it
 * fall back to the hard verify_skipped stop. See loop-evaluator.ts.
 *
 * No-op while a parent turn is in-flight (about to verdict) or while
 * `loopNeedsVerdict` is false (live children / pending ask / …).
 */
let autoVerifyInFlight = false

export function isLoopAutoVerifyInFlight(): boolean {
  return autoVerifyInFlight
}

export function maybeReapIdleLoopVerify(
  platform: string,
  channelId: string,
  threadId: string,
  routeCtx?: import('./router.js').RouteContext,
): LoopExitEnforceResult {
  const active = getActiveLoop(platform, channelId, threadId)
  if (!active) return { ended: false, run: null }
  if (!loopNeedsVerdict(platform, channelId, threadId)) {
    return { ended: false, run: active }
  }
  if (isLoopParentTurnActive(platform, channelId, threadId)) {
    log.debug({
      event: 'loop.reap_deferred_parent_active',
      threadId,
    }, 'skip idle VERIFY reaper while parent turn in-flight')
    return { ended: false, run: active }
  }

  // P1-1: auto-verify replaces the hard stop when opted in and we have a
  // route context to spawn the reviewer with. Fire-and-forget: the reviewer
  // runs as its own A2A subagent; the reaper returns the Loop still active so
  // callers (a2a hook / poll) do not treat it as ended. The reviewer's
  // verdict lands via applyLoopVerdict when it completes.
  if (autoVerifyInFlight) {
    log.debug({ event: 'loop.auto_verify.reentrant_skipped', threadId },
      'auto-verify already in flight; skip re-entrant reap')
    return { ended: false, run: active }
  }
  if (routeCtx && isLoopAutoVerifyEnabled()) {
    autoVerifyInFlight = true
    void (async () => {
      try {
        const { autoVerifyLoopRound } = await import('./loop-evaluator.js')
        const { applyLoopVerdict, getActiveLoop: getActive } = await import('./loop-run.js')
        const current = getActive(platform, channelId, threadId)
        if (!current) return
        const verdict = await autoVerifyLoopRound({
          run: current,
          callerAgent: routeCtx.defaultAgent || 'agim',
          routeCtx,
        })
        if (!verdict) {
          // Reviewer unavailable → hard stop as before.
          forceLoopExitSkippedVerify(platform, channelId, threadId)
          return
        }
        applyLoopVerdict(platform, channelId, threadId, {
          decision: verdict.met ? 'stop' : 'continue',
          summary: verdict.summary,
          met: verdict.met,
          ...(verdict.gaps ? { gaps: verdict.gaps } : {}),
          ...(verdict.nextDirection ? { nextDirection: verdict.nextDirection } : {}),
        })
      } catch (err) {
        log.warn({
          event: 'loop.auto_verify.unhandled',
          threadId,
          err: err instanceof Error ? err.message : String(err),
        }, 'auto-verify round threw; falling back to verify_skipped')
        try { forceLoopExitSkippedVerify(platform, channelId, threadId) } catch { /* last resort */ }
      } finally {
        autoVerifyInFlight = false
      }
    })()
    return { ended: false, run: active }
  }

  const r = forceLoopExitSkippedVerify(platform, channelId, threadId)
  if (r.ended) {
    log.info({
      event: 'loop.reap_idle_verify',
      threadId,
      reason: r.reason,
    }, 'reaped idle Loop VERIFY (parent gone; Subagents settled)')
  }
  return r
}
