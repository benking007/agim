// push-rpc — handles `mcp__imhub__push_message` invocations relayed by the
// approval-bus from MCP sidecars. Lets agents proactively send a message to
// an IM thread without waiting for the user to ask first.
//
// Use cases:
//   - Monitoring loops: "tell me when 600519 limits up" → agent watches a
//     price feed in a separate process and pings via push when triggered.
//   - Long task progress: agent's own status updates beyond the A2A notify
//     pipeline (which is system-driven, not agent-driven).
//   - Scheduled / cron-fired analyses that surface a result.
//
// Security model (v1):
//   - Default scope = caller's OWN thread. The MCP tool resolves the active
//     RunContext (from runId) and uses that thread; agents can NOT push to
//     arbitrary threads they didn't originate from.
//   - Cross-thread targets are gated behind IMHUB_PUSH_CROSS_THREAD=on AND
//     the target must be on the same platform AND user as the caller. No
//     "push to anyone" capability — that would be an obvious abuse vector.
//   - Per-user rate limit: IMHUB_PUSH_RATE_PER_MINUTE (default 10) bursts
//     and falls off over a sliding 60s window. Above the cap → returns
//     error, agent gets to handle it (typically: "sorry, throttled").

import { logger as rootLogger } from './logger.js'
import { sink } from './message-sink.js'
import type { RunContext } from './approval-bus.js'
import { evaluateNotification } from './notification-evaluator.js'

const log = rootLogger.child({ component: 'push-rpc' })

export interface PushPayload {
  /** Body text to send. Required. Empty / whitespace-only → error. */
  text?: unknown
  /** Optional override: <platform>:<channelId>:<threadId>. Same-user same-
   *  platform only; requires IMHUB_PUSH_CROSS_THREAD=on. Omit to push to
   *  the caller's own thread (the common case). */
  toThread?: unknown
  /** Optional placeholder for future card support — ignored for now (v1
   *  is text-only). */
  kind?: unknown
}

export type PushResult =
  | {
      ok: true
      result: {
        outboxId: number
        immediate: boolean
        targetThread: string
        /** D+ Stage 1 (#9) — set true when the notification-evaluator
         *  gate suppressed the message. Outbox row was not enqueued;
         *  `outboxId=0` and `immediate=false` in that case. From the
         *  caller's view the push "succeeded" because the agent did
         *  its part; the gate decides if the human gets pinged. */
        suppressed?: boolean
        /** Reason returned by the evaluator. Empty unless suppressed. */
        suppressedReason?: string
      }
    }
  | { ok: false; error: string }

interface PushBudget {
  /** ts ms epoch of each push in the last 60s window. */
  recent: number[]
}
const budgets = new Map<string, PushBudget>()  // key = `${platform}:${userId}`

function rateLimit(): number {
  const raw = process.env.IMHUB_PUSH_RATE_PER_MINUTE
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 10
}

function crossThreadAllowed(): boolean {
  return (process.env.IMHUB_PUSH_CROSS_THREAD || '').toLowerCase() === 'on'
}

function checkAndRecord(key: string): { ok: true } | { ok: false; resetMs: number } {
  const now = Date.now()
  const cap = rateLimit()
  let budget = budgets.get(key)
  if (!budget) { budget = { recent: [] }; budgets.set(key, budget) }
  // Drop entries older than 60s.
  budget.recent = budget.recent.filter((t) => now - t < 60_000)
  if (budget.recent.length >= cap) {
    const oldest = budget.recent[0]
    return { ok: false, resetMs: 60_000 - (now - oldest) }
  }
  budget.recent.push(now)
  return { ok: true }
}

/** Public entry called by approval-bus.handlePush. */
export async function handlePushOp(payload: PushPayload, ctx: RunContext): Promise<PushResult> {
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) return { ok: false, error: 'text is required (non-empty string)' }
  if (text.length > 4000) return { ok: false, error: 'text too long (max 4000 chars)' }

  // Resolve target thread.
  let targetPlatform = ctx.platform
  let targetChannelId = ctx.channelId
  let targetThreadId = ctx.threadId

  const toThread = typeof payload.toThread === 'string' ? payload.toThread.trim() : ''
  if (toThread) {
    if (!crossThreadAllowed()) {
      return { ok: false, error: 'cross-thread push is disabled (set IMHUB_PUSH_CROSS_THREAD=on to enable)' }
    }
    const parts = toThread.split(':')
    if (parts.length < 3) {
      return { ok: false, error: `toThread must be "platform:channelId:threadId" (got "${toThread}")` }
    }
    const [pl, ch, ...rest] = parts
    if (pl !== ctx.platform) {
      return { ok: false, error: `cross-platform push refused (caller=${ctx.platform}, target=${pl})` }
    }
    targetPlatform = pl
    targetChannelId = ch
    targetThreadId = rest.join(':')
  }

  // Rate limit per (platform, userId).
  const rlKey = `${ctx.platform}:${ctx.userId || 'anon'}`
  const rl = checkAndRecord(rlKey)
  if (!rl.ok) {
    return {
      ok: false,
      error: `rate limit exceeded (${rateLimit()}/min for user ${ctx.userId}); retry in ${Math.ceil(rl.resetMs / 1000)}s`,
    }
  }

  const targetThreadStr = `${targetPlatform}:${targetChannelId}:${targetThreadId}`

  // D+ Stage 1 follow-up (#9) — agent-initiated push goes through the
  // notification evaluator. Fail-open: any infrastructure failure (no
  // backend, LLM error, etc.) lets the message through. Returns
  // shouldDeliver=false only when the LLM explicitly judges the body
  // routine / empty. Suppression already audit-logged inside the
  // evaluator — we just translate to a "soft success" so the agent
  // doesn't think it failed.
  const verdict = await evaluateNotification({
    source: 'push',
    text,
    targetThread: targetThreadStr,
    caller: {
      platform: ctx.platform,
      userId: ctx.userId,
      agent: ctx.callerAgent,
    },
    // No traceId — RunContext doesn't carry one. audit row records
    // actor=platform:userId, sufficient for "who got their msg gated".
  })
  if (!verdict.shouldDeliver) {
    log.info({
      event: 'push.suppressed',
      caller: { platform: ctx.platform, userId: ctx.userId, threadId: ctx.threadId },
      target: targetThreadStr,
      via: verdict.via,
      reason: verdict.reason,
      textLen: text.length,
    })
    return {
      ok: true,
      result: {
        outboxId: 0,
        immediate: false,
        targetThread: targetThreadStr,
        suppressed: true,
        suppressedReason: verdict.reason,
      },
    }
  }

  // Deliver via sink as a SYSTEM source so it stays inline (doesn't get
  // viewer-routed) and uses normal priority (no preemption).
  try {
    const r = await sink.deliver({
      platform: targetPlatform,
      channelId: targetChannelId,
      threadId: targetThreadId,
      payload: text,
      kind: 'text',
      priority: 'normal',
      source: 'system',
    })
    log.info({
      event: 'push.delivered',
      caller: { platform: ctx.platform, userId: ctx.userId, threadId: ctx.threadId },
      target: targetThreadStr,
      outboxId: r.outboxId, immediate: r.immediate,
      textLen: text.length,
    })
    return {
      ok: true,
      result: { outboxId: r.outboxId, immediate: r.immediate, targetThread: targetThreadStr },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ event: 'push.deliver_failed', err: msg })
    return { ok: false, error: `sink delivery failed: ${msg}` }
  }
}
