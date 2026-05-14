// Message Sink — single chokepoint for all outbound IM messages.
//
// Why exist:
//   - Previously, sendMessage was called directly from 5 sites (cli main
//     loop, reminders, approval-router x2, restart-completion). Any of
//     these losing a reply due to messenger error / brief disconnect /
//     adapter crash dropped the message irrecoverably.
//   - Sink writes every outbound to the persistent outbox table first
//     (or tries a sync send for priority=high then falls back to the
//     queue on failure). A background worker drains the queue with
//     exponential backoff. Replies survive crashes and reconnects.
//
// Design constraints (per docs/task-recovery-plan.md):
//   - Reminder polish, memo polish, and any other content-shaping logic
//     happens *upstream* of sink — sink only receives plain payload + IM
//     coordinates. Don't add transformations here.
//   - Worker is single-threaded to preserve per-thread ordering. If
//     throughput becomes a bottleneck, partition by thread_key.
//   - Approval cards with messageId return paths (sendApprovalCard /
//     editApprovalCard) do NOT go through sink — they need the synchronous
//     messageId for the card-edit flow. Only plain text fallbacks from
//     approval-router migrate to sink.
//   - Don't bring up the worker until messengers have finished start()
//     (cli.ts calls sink.startWorker() after registry.start()). Otherwise
//     the very first tick after restart hits "messenger not registered"
//     for every queued row.

import type { MessengerAdapter } from './types.js'
import { registry } from './registry.js'
import { logger as rootLogger } from './logger.js'
import {
  enqueue, pickPending, markDelivered, markFailed,
  type OutboxKind, type OutboxPriority, type OutboxRow,
} from './outbox.js'

const log = rootLogger.child({ component: 'message-sink' })

export type SinkKind = OutboxKind
export type SinkPriority = OutboxPriority

export interface SinkPayload {
  threadId: string
  platform: string
  channelId: string
  /** For 'text': the message body (string).
   *  For 'card': the card object (will be JSON-encoded for storage).
   *  For 'typing': 'start' or 'stop'. */
  payload: string | object
  kind: SinkKind
  /** Default 'normal'. 'high' tries a synchronous send first and falls
   *  back to the queue only on failure — use for approval / restart
   *  notices where 1s+ worker latency matters. */
  priority?: SinkPriority
  /** Link this delivery back to a jobs row (inline job / scheduled job).
   *  Phase 2 will use this to mark jobs.status='delivered' when the row
   *  reaches the IM. */
  jobId?: number | null
  /** Optional explicit thread key. Default is
   *  `${platform}:${channelId}:${threadId}` (matches session.ts). */
  threadKey?: string
  /** Optional already-resolved adapter. When provided, sink uses it
   *  directly for the sync attempt instead of consulting the global
   *  registry. Required by callers that maintain their own resolution
   *  indirection (e.g. approval-router.install accepts a custom
   *  resolveMessenger hook used by tests + multi-tenant setups). The
   *  outbox row is still recorded with platform=<name>; if the sync
   *  attempt fails, the worker re-resolves via registry the normal way. */
  adapter?: MessengerAdapter
}

export interface SinkResult {
  /** Row id in the outbox table. -1 if persistence is unavailable AND the
   *  sync fallback also failed (the rare double-failure case — caller has
   *  no recourse beyond logging). */
  outboxId: number
  /** True = the message was sent inline before this call returned (only
   *  possible when priority='high' and the sync attempt succeeded).
   *  False = queued for the worker. */
  immediate: boolean
}

function defaultThreadKey(p: SinkPayload): string {
  return p.threadKey ?? `${p.platform}:${p.channelId}:${p.threadId}`
}

function payloadToString(payload: SinkPayload['payload']): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload)
}

/** Resolve a platform name (e.g. 'wechat' / 'wechat-ilink' / 'feishu') to
 *  the actual MessengerAdapter. Exact match first, then a fuzzy `${name}-*`
 *  / `${name}_*` prefix walk so reminders.ts / scheduler / web callers can
 *  pass the generic platform ('wechat') and still hit 'wechat-ilink'. Mirrors
 *  the helper that already exists in reminders.ts:873 — kept in sink so the
 *  rest of the codebase can stop caring about adapter naming.
 *
 *  Exported for tests; production callers go through deliver(). */
export function resolveMessenger(platform: string): MessengerAdapter | undefined {
  const exact = registry.getMessenger(platform)
  if (exact) return exact
  for (const name of registry.listMessengers()) {
    if (name === platform || name.startsWith(`${platform}-`) || name.startsWith(`${platform}_`)) {
      return registry.getMessenger(name)
    }
  }
  return undefined
}

/** Attempt the actual messenger send. Throws on failure so the worker
 *  loop can record it via markFailed(). For 'card' on adapters without
 *  sendCard, we fall back to a JSON-stringified text body so the message
 *  is still surfaced (better than dropping silently).
 *
 *  If `overrideAdapter` is provided the sync path uses it directly (the
 *  caller has already done resolution); the worker tick never passes
 *  one and always re-resolves via registry. */
async function doSend(row: OutboxRow, overrideAdapter?: MessengerAdapter): Promise<void> {
  const adapter: MessengerAdapter | undefined = overrideAdapter ?? resolveMessenger(row.platform)
  if (!adapter) {
    throw new Error(`messenger not registered: ${row.platform}`)
  }

  if (row.kind === 'text') {
    await adapter.sendMessage(row.thread_id, row.payload)
    return
  }
  if (row.kind === 'card') {
    if (adapter.sendCard) {
      let cardObj: unknown
      try {
        cardObj = JSON.parse(row.payload)
      } catch {
        throw new Error('card payload is not valid JSON')
      }
      await adapter.sendCard(row.thread_id, cardObj)
      return
    }
    // No native card support → degrade to text. The adapter's sendMessage
    // path is required by the type contract so this is always safe.
    await adapter.sendMessage(row.thread_id, row.payload)
    return
  }
  if (row.kind === 'typing') {
    if (adapter.sendTyping) {
      const isTyping = row.payload === 'start'
      await adapter.sendTyping(row.thread_id, isTyping)
    }
    // Adapter lacks typing → silently no-op. Typing indicators are
    // best-effort; never re-queue.
    return
  }
  throw new Error(`unknown outbox kind: ${row.kind}`)
}

// ---------------------------------------------------------------------------
// Public API: deliver()
// ---------------------------------------------------------------------------

export async function deliver(p: SinkPayload): Promise<SinkResult> {
  const priority: SinkPriority = p.priority ?? 'normal'
  const threadKey = defaultThreadKey(p)
  const payloadStr = payloadToString(p.payload)

  // Typing indicators are pure UX hints — never persist them. If the worker
  // delivered a "start typing" row two minutes later it would be ridiculous.
  // We fire-and-forget directly; failure is ignored.
  if (p.kind === 'typing') {
    const adapter = p.adapter ?? resolveMessenger(p.platform)
    if (adapter?.sendTyping) {
      try {
        await adapter.sendTyping(p.threadId, payloadStr === 'start')
      } catch (err) {
        log.debug({ event: 'sink.typing_failed', err: err instanceof Error ? err.message : String(err) },
          'typing send failed (ignored)')
      }
    }
    return { outboxId: -1, immediate: true }
  }

  if (priority === 'high') {
    // Try sync first. Build a synthetic row so doSend() works against the
    // same code path the worker uses. attempts=0 — we haven't recorded
    // anything yet.
    const synthetic: OutboxRow = {
      id: -1, job_id: p.jobId ?? null, thread_key: threadKey,
      platform: p.platform, channel_id: p.channelId, thread_id: p.threadId,
      payload: payloadStr, kind: p.kind, priority,
      status: 'pending', attempts: 0,
      last_attempt_at: null, last_error: null, delivered_at: null,
      next_attempt_at: null, created_at: new Date().toISOString(),
    }
    try {
      await doSend(synthetic, p.adapter)
      // Sync win — record a delivered row for audit + Phase 2 jobs.delivered_at hook.
      const id = enqueue({
        threadKey, platform: p.platform, channelId: p.channelId, threadId: p.threadId,
        payload: payloadStr, kind: p.kind, priority, jobId: p.jobId ?? null,
      })
      if (id > 0) markDelivered(id)
      return { outboxId: id, immediate: true }
    } catch (err) {
      log.warn({
        event: 'sink.high_priority_sync_failed',
        platform: p.platform,
        threadId: p.threadId,
        err: err instanceof Error ? err.message : String(err),
      }, 'high-priority sync send failed; falling back to outbox queue')
      // Fall through to enqueue + worker tries again later.
    }
  }

  // priority='normal' (or 'high' fallback): enqueue and let the worker drain.
  const id = enqueue({
    threadKey, platform: p.platform, channelId: p.channelId, threadId: p.threadId,
    payload: payloadStr, kind: p.kind, priority, jobId: p.jobId ?? null,
  })
  if (id < 0) {
    // Outbox itself is broken (sqlite disabled, e.g. on bun without the
    // native module). Last-ditch: send directly so the user still gets
    // a reply on this happy path. Failure here is logged and dropped —
    // there is no remaining mechanism to recover.
    log.error({ event: 'sink.outbox_unavailable', platform: p.platform, threadId: p.threadId },
      'outbox enqueue returned -1; attempting last-ditch direct send')
    try {
      await doSend({
        id: -1, job_id: p.jobId ?? null, thread_key: threadKey,
        platform: p.platform, channel_id: p.channelId, thread_id: p.threadId,
        payload: payloadStr, kind: p.kind, priority,
        status: 'pending', attempts: 0,
        last_attempt_at: null, last_error: null, delivered_at: null,
        next_attempt_at: null, created_at: new Date().toISOString(),
      }, p.adapter)
      return { outboxId: -1, immediate: true }
    } catch (err) {
      log.error({ event: 'sink.last_ditch_failed', err: err instanceof Error ? err.message : String(err) },
        'last-ditch send failed; message is lost')
      return { outboxId: -1, immediate: false }
    }
  }
  return { outboxId: id, immediate: false }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/** How often the worker pulls pending rows. Override with IMHUB_OUTBOX_TICK_MS. */
function resolveTickMs(): number {
  const raw = process.env.IMHUB_OUTBOX_TICK_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 1000
}

/** Max rows pulled per tick. Worker is single-threaded so this caps how
 *  long one tick can take before it self-yields. */
function resolveBatchSize(): number {
  const raw = process.env.IMHUB_OUTBOX_BATCH
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 10
}

let workerTimer: ReturnType<typeof setInterval> | null = null
let workerBusy = false
let workerStopRequested = false

async function workerTick(): Promise<void> {
  if (workerBusy) return  // previous tick still running
  workerBusy = true
  try {
    const batch = pickPending(resolveBatchSize())
    for (const row of batch) {
      if (workerStopRequested) break
      try {
        await doSend(row)
        markDelivered(row.id)
        log.debug({ event: 'sink.delivered', id: row.id, platform: row.platform, kind: row.kind },
          'outbox row delivered')
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const { gaveUp, attempts } = markFailed(row.id, errMsg)
        log.warn({
          event: gaveUp ? 'sink.giving_up' : 'sink.retry_scheduled',
          id: row.id, platform: row.platform, kind: row.kind,
          attempts, err: errMsg,
        }, gaveUp
          ? `outbox row ${row.id} gave up after ${attempts} attempts: ${errMsg}`
          : `outbox row ${row.id} failed (attempt ${attempts}), will retry`)
      }
    }
  } finally {
    workerBusy = false
  }
}

export function startWorker(): void {
  if (workerTimer !== null) return
  workerStopRequested = false
  const ms = resolveTickMs()
  workerTimer = setInterval(() => {
    void workerTick().catch((err) => {
      log.error({ event: 'sink.worker_unhandled', err: err instanceof Error ? err.message : String(err) },
        'worker tick threw unhandled')
    })
  }, ms)
  // Don't keep the process alive just for the worker — let SIGTERM / SIGINT
  // shut things down naturally.
  if (typeof workerTimer === 'object' && workerTimer && 'unref' in workerTimer) {
    (workerTimer as { unref: () => void }).unref()
  }
  log.info({ event: 'sink.worker_started', tickMs: ms }, 'outbox worker started')
}

export function stopWorker(): void {
  workerStopRequested = true
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
    log.info({ event: 'sink.worker_stopped' }, 'outbox worker stopped')
  }
}

/** Test hook — run one tick synchronously. */
export async function _tickWorkerForTests(): Promise<void> {
  await workerTick()
}

// Convenience namespace export so call sites read `sink.deliver(...)`.
export const sink = {
  deliver,
  startWorker,
  stopWorker,
}
