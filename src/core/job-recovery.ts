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
import { sink, resolveMessenger } from './message-sink.js'
import type { ButtonCallback } from './types.js'

const log = rootLogger.child({ component: 'job-recovery' })

/** Choice-card `data` prefix this module owns. approval-router's button
 *  dispatch forwards taps starting with this prefix to handleRecoveryButton. */
const RECOVERY_CB_PREFIX = 'rec:'

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
  /** v1.2 — id of the choice card we sent for this entry (if the adapter
   *  supported sendChoiceCard). Used to edit the card to its terminal text
   *  after the user picks a button or replies via text. Null when we fell
   *  back to plain text. */
  cardMessageId: string | null
}

/** Thread-keyed pending entries. One per thread — if a thread happens to
 *  have multiple interrupted rows (rare), we surface the most recent only
 *  and the rest get swept to 'abandoned' next sweep. */
const pending: Map<string, PendingRetry> = new Map()

/**
 * v1.2 — executor hook injected by cli.ts at boot. When the user accepts
 * a retry (via text "1" OR button "🔁 重发"), the new inline-job row is
 * created here but the agent never runs unless we feed a synthetic
 * MessageContext through cli's handleMessage. cli.ts owns that closure
 * (it has the registry, sink, agent dispatcher) so we register the
 * callback here and invoke it after a successful retry.
 *
 * Without this hook the row stays in 'pending' forever. That bug
 * affected the button path only (text path was working via the
 * messenger's own onMessage chain).
 */
export interface RecoveryExecutorArgs {
  entry: PendingRetry
  newJobId: number
}
export type RecoveryExecutor = (args: RecoveryExecutorArgs) => Promise<void>
let recoveryExecutor: RecoveryExecutor | null = null
export function setRecoveryExecutor(fn: RecoveryExecutor | null): void {
  recoveryExecutor = fn
}

/** Test hook — wipe the in-memory state. */
export function _resetPendingForTests(): void {
  pending.clear()
  recoveryExecutor = null
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
    const entry: PendingRetry = {
      jobId: j.id,
      agent: j.agent,
      prompt: j.prompt,
      threadKey: key,
      platform: parsed.platform,
      channelId: parsed.channelId,
      threadId: parsed.threadId,
      creatorId: j.creator_id,
      expiresAt: interruptedAtMs + windowMs,
      cardMessageId: null,
    }
    pending.set(key, entry)

    // v1.2 — try the platform's native choice card first; fall back to plain
    // text when the adapter doesn't implement sendChoiceCard (WeChat-iLink,
    // DingTalk text mode, …). Both paths support text replies ("1" / "重发")
    // so the user always has a way out.
    const cardSent = await trySendRecoveryCard(entry, windowMin)
    if (cardSent) {
      entry.cardMessageId = cardSent
      notified++
      continue
    }
    try {
      await sink.deliver({
        platform: parsed.platform,
        channelId: parsed.channelId,
        threadId: parsed.threadId,
        payload: formatNotice(j, windowMin),
        kind: 'text',
        priority: 'normal',
        source: 'system',
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

async function editCardForTextReply(entry: PendingRetry, finalText: string): Promise<void> {
  const adapter = resolveMessenger(entry.platform)
  if (!adapter?.editChoiceCard || !entry.cardMessageId) return
  try {
    await adapter.editChoiceCard(entry.threadId, entry.cardMessageId, finalText)
    log.info({
      event: 'recovery.text_reply.card_edited',
      jobId: entry.jobId, finalText: finalText.slice(0, 60),
    })
  } catch (err) {
    log.warn({
      event: 'recovery.text_reply.card_edit_failed',
      jobId: entry.jobId, err: err instanceof Error ? err.message : String(err),
    }, 'editing card after text reply failed — buttons may stay live until card expires')
  }
}

/** Try to interpret a user's reply as a recovery decision. Returns an
 *  outcome the caller can render. Side-effect: on a recognized decision,
 *  the pending entry is removed and the DB row transitions. When the
 *  entry was originally sent as a native choice card, this also edits
 *  the card to its terminal state so its buttons can't be tapped after
 *  the user already replied with text — otherwise a stale tap would
 *  hit the "请求已过期" branch and read as a glitch. */
export function tryHandleRecoveryReply(threadKey: string, text: string): RecoveryReplyOutcome {
  const entry = pending.get(threadKey)
  if (!entry) return { kind: 'not-pending' }

  const trimmed = text.trim()
  const isRetry = /^(1|重发|重试|retry|y|yes)$/i.test(trimmed)
  const isCancel = /^(2|取消|算了|cancel|n|no)$/i.test(trimmed)

  if (!isRetry && !isCancel) return { kind: 'not-recovery-reply' }

  pending.delete(threadKey)

  // Fire-and-forget: if there's a card attached to this entry, edit it
  // to terminal text + strip buttons. Errors logged but don't block the
  // outcome the caller is waiting on.
  if (entry.cardMessageId) {
    const finalText = isRetry
      ? `🔁 已重发 · ${nowHm()}\n「${entry.prompt.replace(/\s+/g, ' ').slice(0, 60)}…」`
      : `✖ 已取消 · ${nowHm()}`
    void editCardForTextReply(entry, finalText)
  }

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

// ─── v1.2: native choice-card flow ────────────────────────────────────

/** Render the card prompt for one interrupted entry. */
function buildChoiceCard(entry: PendingRetry, windowMin: number): import('./types.js').ChoiceCardPrompt {
  const flat = entry.prompt.replace(/\s+/g, ' ').trim()
  const preview = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
  return {
    title: '⚠️ 上次的消息被服务重启中断了',
    body: `「${preview}」\n${windowMin} 分钟内有效`,
    choices: [
      { label: '🔁 重发', data: `${RECOVERY_CB_PREFIX}${entry.jobId}:y` },
      { label: '✖ 取消', data: `${RECOVERY_CB_PREFIX}${entry.jobId}:n` },
    ],
  }
}

/** Try to send a native choice card via the adapter. Returns the new
 *  message id on success, null if the adapter doesn't support it (so caller
 *  can fall back to plain text). */
async function trySendRecoveryCard(entry: PendingRetry, windowMin: number): Promise<string | null> {
  const adapter = resolveMessenger(entry.platform)
  if (!adapter?.sendChoiceCard) return null
  try {
    const sent = await adapter.sendChoiceCard(entry.threadId, buildChoiceCard(entry, windowMin))
    log.info({
      event: 'recovery.card_sent',
      jobId: entry.jobId,
      platform: entry.platform,
      messageId: sent.messageId,
    })
    return sent.messageId
  } catch (err) {
    log.warn({
      event: 'recovery.card_send_failed',
      jobId: entry.jobId,
      err: err instanceof Error ? err.message : String(err),
    }, 'sendChoiceCard threw — falling back to plain text')
    return null
  }
}

/**
 * True if the given callback_data belongs to a recovery prompt — used by
 * approval-router's button dispatcher to route the tap to us instead of
 * the approval flow.
 */
export function isRecoveryButtonData(data: string): boolean {
  return typeof data === 'string' && data.startsWith(RECOVERY_CB_PREFIX)
}

/** In-process dedupe of repeated callback_query deliveries — Telegram may
 *  retry the callback if it doesn't see an ack in time. Without this,
 *  the second delivery sees an empty pending map → "expired" branch fires
 *  and may overwrite the just-set terminal card. */
const recentClicks = new Map<string, number>()  // `${jobId}:${choice}` → ts
const CLICK_DEDUPE_MS = 30_000

function isDuplicateClick(jobId: number, choice: string): boolean {
  const key = `${jobId}:${choice}`
  const ts = Date.now()
  // Sweep stale entries opportunistically.
  for (const [k, t] of recentClicks.entries()) {
    if (ts - t > CLICK_DEDUPE_MS) recentClicks.delete(k)
  }
  if (recentClicks.has(key)) return true
  recentClicks.set(key, ts)
  return false
}

function nowHm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Handle a button tap on a recovery card. Mirrors tryHandleRecoveryReply's
 * semantics: returns the outcome the caller can act on. Also edits the
 * card (drops the buttons) so a stale tap can't fire twice.
 */
export async function handleRecoveryButton(platform: string, cb: ButtonCallback): Promise<RecoveryReplyOutcome | null> {
  const remainder = cb.data.slice(RECOVERY_CB_PREFIX.length)  // e.g. "42:y"
  const [jobIdStr, choice] = remainder.split(':')
  const jobId = Number.parseInt(jobIdStr, 10)
  if (!Number.isFinite(jobId) || (choice !== 'y' && choice !== 'n')) {
    log.warn({ event: 'recovery.button.bad_data', data: cb.data })
    await cb.ack('按钮数据格式错误').catch(() => {})
    return null
  }

  log.info({
    event: 'recovery.button.received',
    platform, jobId, choice, threadId: cb.threadId, messageId: cb.messageId,
  })

  // Dedupe identical clicks within a short window — Telegram resends
  // callbacks when ack times out; we don't want to double-process.
  if (isDuplicateClick(jobId, choice)) {
    log.info({ event: 'recovery.button.dedup_skip', jobId, choice })
    await cb.ack().catch(() => {})  // silent ack; no card edit
    return null
  }

  // Look up the pending entry by jobId.
  let entry: PendingRetry | undefined
  let entryKey: string | undefined
  for (const [k, v] of pending.entries()) {
    if (v.jobId === jobId) { entry = v; entryKey = k; break }
  }
  if (!entry || !entryKey) {
    await cb.ack('请求已过期').catch(() => {})
    const adapter = resolveMessenger(platform)
    if (adapter?.editChoiceCard) {
      await adapter.editChoiceCard(cb.threadId, cb.messageId, `⏱ 已过期 · ${nowHm()}`).catch(() => {})
    }
    return null
  }

  // Only the original requester may resolve the card. In group chats
  // anyone can see the buttons; without this check a bystander could
  // tap "取消" and kill someone else's retry — or worse, tap "重发" and
  // re-run a prompt that wasn't theirs.
  if (entry.creatorId && cb.userId && entry.creatorId !== cb.userId) {
    log.warn({
      event: 'recovery.button.unauthorized_tapper',
      jobId, expected: entry.creatorId, actual: cb.userId,
    })
    await cb.ack('只有发起者可以处理这条消息').catch(() => {})
    return null
  }

  const reply = choice === 'y' ? '1' : '2'
  const outcome = tryHandleRecoveryReply(entryKey, reply)

  const ackText = choice === 'y' ? '🔁 已请求重发' : '✖ 已取消'
  await cb.ack(ackText).catch(() => {})

  // Append a HH:MM marker to the edit text so a retry-delivery's "not
  // modified" edit doesn't silently swallow the visual update (Telegram
  // rejects edits whose new content matches the current).
  const adapter = resolveMessenger(platform)
  if (adapter?.editChoiceCard) {
    const finalText = choice === 'y'
      ? `🔁 已重发 · ${nowHm()}\n「${entry.prompt.replace(/\s+/g, ' ').slice(0, 60)}…」`
      : `✖ 已取消 · ${nowHm()}`
    await adapter.editChoiceCard(cb.threadId, cb.messageId, finalText).catch(() => {})
    log.info({ event: 'recovery.button.edited', jobId, choice, finalText: finalText.slice(0, 60) })
  }

  // P0-3 fix: button-tap path was creating the replacement row but never
  // running the agent. Invoke the executor cli.ts registered at boot.
  if (outcome.kind === 'retried' && recoveryExecutor) {
    try {
      await recoveryExecutor({ entry: outcome.entry, newJobId: outcome.newJobId })
    } catch (err) {
      log.warn({
        event: 'recovery.button.executor_failed', jobId, err: String(err),
      }, 'retry executor threw — replacement job created but agent did not run')
    }
  } else if (outcome.kind === 'retried' && !recoveryExecutor) {
    log.warn({
      event: 'recovery.button.no_executor', jobId,
    }, 'no executor registered — replacement job will stay pending')
  }

  return outcome
}
