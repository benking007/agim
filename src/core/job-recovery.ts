// Job recovery — Phase 3 lifecycle hook.
//
// On startup, after messengers + sink worker are wired, this module walks
// the jobs table looking for `kind='inline' status='interrupted'` rows
// whose interruption happened inside the recovery window (default 10 min).
// For each such row it:
//
//   1. Sends a one-shot retry prompt to the originating thread via sink.
//      Falls back to outbox queue if the IM platform is still warming up.
//   2. Registers the row in an in-memory per-thread map keyed by
//      `${platform}:${channelId}:${threadId}`. The map entry expires after
//      the window so a forgotten interruption doesn't hijack the user's
//      next message forever.
//   3. The cli message handler calls `tryHandleRecoveryReply()` at the
//      top of every inbound message; if the thread has a pending
//      interrupted-job and the message looks like "1" / "重发" / "2" /
//      "取消", we resolve the choice + clear the entry.
//
// Older interrupted rows (past the window) get swept to 'abandoned' so the
// table stays bounded.
//
// Module-level state:
//   - `pending` is in-memory only. Process restarts wipe it. That's
//     intentional: each restart re-runs scanInterruptedAndNotify() and
//     re-derives the state from SQLite. We don't ever want a recovery
//     entry that outlives the row it points at.

import { logger as rootLogger } from './logger.js'
import {
  type Job,
  createInlineJob,
  findRecoverableInterrupted,
  getRecoveryWindowMs,
  markInterruptedCancelled,
  markJobReplacedBy,
  sweepAbandonedInterrupted,
} from './job-board.js'
import { sink } from './message-sink.js'

const log = rootLogger.child({ component: 'job-recovery' })

interface PendingRetry {
  jobId: number
  agent: string
  prompt: string
  threadKey: string
  platform: string
  channelId: string
  threadId: string
  creatorId: string
  /** ms-epoch when the entry expires (interrupted_at + window). */
  expiresAt: number
}

/** Thread-keyed pending entries. One per thread — if a thread happens to
 *  have multiple interrupted rows (rare), we surface the most recent only
 *  and the rest get swept to 'abandoned' next sweep. */
const pending: Map<string, PendingRetry> = new Map()

/** Test hook — wipe the in-memory state. */
export function _resetPendingForTests(): void {
  pending.clear()
}

/** Test hook — inspect current state. */
export function _peekPendingForTests(): Map<string, PendingRetry> {
  return new Map(pending)
}

function buildThreadKey(j: Job): string {
  // Inline jobs always carry thread_key; if some legacy row doesn't, we skip
  // (caller filters that out, but defense-in-depth).
  return j.thread_key
}

function parseThreadKey(key: string): { platform: string; channelId: string; threadId: string } | null {
  // Composite is `${platform}:${channelId}:${threadId}` but threadId itself
  // may contain ':' (Discord, some web clients). Split off the first two
  // segments and treat the rest as threadId.
  const parts = key.split(':')
  if (parts.length < 3) return null
  return { platform: parts[0], channelId: parts[1], threadId: parts.slice(2).join(':') }
}

function previewPrompt(p: string, max: number = 40): string {
  const flat = p.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function formatNotice(j: Job, windowMin: number): string {
  return [
    '⚠️ 上次的消息被服务重启中断了：',
    `「${previewPrompt(j.prompt)}」`,
    '',
    `回复 \`1\` 重发 / \`2\` 取消（${windowMin} 分钟内有效）`,
  ].join('\n')
}

/** Run once on agim startup, after messengers + sink are up. */
export async function scanInterruptedAndNotify(): Promise<{ notified: number; abandoned: number }> {
  const windowMs = getRecoveryWindowMs()
  const windowMin = Math.round(windowMs / 60_000)

  // First sweep stale rows so the notify pass doesn't waste cycles on them.
  const abandoned = sweepAbandonedInterrupted(windowMs)

  const rows = findRecoverableInterrupted(windowMs)
  let notified = 0

  for (const j of rows) {
    const key = buildThreadKey(j)
    const parsed = parseThreadKey(key)
    if (!parsed) {
      log.warn({ event: 'recovery.bad_thread_key', jobId: j.id, threadKey: key },
        'skipping row with malformed thread_key')
      continue
    }
    // Only the most recent per-thread row goes into the pending map. Older
    // ones get swept to 'cancelled' so the user isn't asked to retry two
    // overlapping interruptions on the same thread.
    if (pending.has(key)) {
      markInterruptedCancelled(j.id)
      continue
    }
    const interruptedAtMs = j.completed_at
      ? Date.parse(`${j.completed_at}Z`)
      : Date.now()
    pending.set(key, {
      jobId: j.id,
      agent: j.agent,
      prompt: j.prompt,
      threadKey: key,
      platform: parsed.platform,
      channelId: parsed.channelId,
      threadId: parsed.threadId,
      creatorId: j.creator_id,
      expiresAt: interruptedAtMs + windowMs,
    })
    try {
      await sink.deliver({
        platform: parsed.platform,
        channelId: parsed.channelId,
        threadId: parsed.threadId,
        payload: formatNotice(j, windowMin),
        kind: 'text',
        priority: 'normal',
      })
      notified++
    } catch (err) {
      log.warn({
        event: 'recovery.notify_failed', jobId: j.id, threadKey: key,
        err: err instanceof Error ? err.message : String(err),
      }, 'recovery notice send threw — sink already enqueues, this is best-effort')
    }
  }

  if (notified > 0 || abandoned > 0) {
    log.info({ event: 'recovery.scan_done', notified, abandoned, windowMs },
      `Recovery scan: notified ${notified}, abandoned ${abandoned}`)
  }
  return { notified, abandoned }
}

/** Periodic in-memory expiry sweep. Removes entries whose `expiresAt` has
 *  passed without a user reply. Called from cli.ts on a setInterval. */
export function sweepExpiredPending(now: number = Date.now()): number {
  let n = 0
  for (const [key, entry] of pending.entries()) {
    if (entry.expiresAt <= now) {
      pending.delete(key)
      // Row in DB stays 'interrupted' until the next startup scan re-sweeps
      // it to 'abandoned'. That's fine — abandoned-at-DB and expired-in-memory
      // converge eventually.
      n++
    }
  }
  return n
}

/** Result of a recovery-reply attempt. */
export type RecoveryReplyOutcome =
  | { kind: 'not-pending' }
  | { kind: 'not-recovery-reply' }
  | { kind: 'retried'; newJobId: number; oldJobId: number; entry: PendingRetry }
  | { kind: 'cancelled'; oldJobId: number }

/** Try to interpret a user's reply as a recovery decision. Returns an
 *  outcome the caller can render. Side-effect: on a recognized decision,
 *  the pending entry is removed and the DB row transitions. */
export function tryHandleRecoveryReply(threadKey: string, text: string): RecoveryReplyOutcome {
  const entry = pending.get(threadKey)
  if (!entry) return { kind: 'not-pending' }

  const trimmed = text.trim()
  const isRetry = /^(1|重发|重试|retry|y|yes)$/i.test(trimmed)
  const isCancel = /^(2|取消|算了|cancel|n|no)$/i.test(trimmed)

  if (!isRetry && !isCancel) return { kind: 'not-recovery-reply' }

  pending.delete(threadKey)

  if (isCancel) {
    markInterruptedCancelled(entry.jobId)
    return { kind: 'cancelled', oldJobId: entry.jobId }
  }

  // Retry: spawn a new inline job with the same prompt + thread coordinates
  // so the cli main loop's onAgentResolved hook (which won't run here —
  // recovery is outside the message handler) won't update the agent. We
  // use the agent that was recorded on the original row. The new row goes
  // straight to 'pending' for whatever picks it up next; recovery itself
  // doesn't run the agent — it relies on the cli main loop seeing this
  // row's prompt re-injected. The caller (router intercept) decides how
  // to actually run it (typically: synthesize an inbound message with
  // entry.prompt and let handleMessage do its normal thing).
  const newJobId = createInlineJob({
    agent: entry.agent,
    prompt: entry.prompt,
    threadKey: entry.threadKey,
    creatorId: entry.creatorId,
  })
  if (newJobId > 0) markJobReplacedBy(entry.jobId, newJobId)
  return { kind: 'retried', newJobId, oldJobId: entry.jobId, entry }
}

/** Convenience for cli.ts: was the thread expecting a recovery reply just
 *  before we routed this message? Used to skip approval / reminder
 *  interceptors when the user is replying to a recovery prompt. */
export function hasPendingRecovery(threadKey: string): boolean {
  return pending.has(threadKey)
}
