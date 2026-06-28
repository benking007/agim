// memory-distiller — "dream distillation" scheduler.
//
// Instead of extracting facts after every reply (per-turn LLM cost on the hot
// path), the router now just BUFFERS each turn into pending_distill. This
// background pass batch-extracts those buffered turns when the system is idle
// (no active agent jobs) — or, on a continuously-busy bot, once a user's
// oldest buffered turn passes the staleness floor so facts never lag forever.
//
// Independent of the 24h persona consolidator (memory-consolidate.ts): this
// only writes raw facts; consolidation rolls them into the summary on its own
// cadence.
//
// Tunables (env):
//   IMHUB_MEMORY_DISTILL_ENABLED       master toggle (default on when memory on)
//   IMHUB_MEMORY_DISTILL_INTERVAL_MS   tick interval (default 300000 = 5 min)
//   IMHUB_MEMORY_DISTILL_FLOOR_MIN     force-flush staleness floor (default 30)
//   IMHUB_MEMORY_DISTILL_BATCH_MAX     turns per extraction call (default 20)

import { logger as rootLogger } from './logger.js'
import { isMemoryEnabled } from './persona.js'
import { _activeJobCount } from './job-board.js'
import { listPendingUserKeys, listPendingForUser, deletePendingByIds, countPendingTotal } from './memory.js'
import { runBatchDistillation } from './memory-distill.js'

const log = rootLogger.child({ component: 'memory-distiller' })
let timer: ReturnType<typeof setInterval> | null = null

interface DistillerStatus {
  running: boolean
  lastRunAt: number | null
  lastProcessed: number
  lastError: string | null
}
const status: DistillerStatus = { running: false, lastRunAt: null, lastProcessed: 0, lastError: null }

/** Status snapshot for the web Memory tab (POST /api/memory/distill/status). */
export function getDistillerStatus(): DistillerStatus & { pendingTotal: number; enabled: boolean } {
  return { ...status, pendingTotal: countPendingTotal(), enabled: isDistillerEnabled() }
}

function intervalMs(): number {
  const n = Number(process.env.IMHUB_MEMORY_DISTILL_INTERVAL_MS)
  return Number.isFinite(n) && n >= 10_000 ? n : 300_000
}
function floorSec(): number {
  const n = Number(process.env.IMHUB_MEMORY_DISTILL_FLOOR_MIN)
  return (Number.isFinite(n) && n >= 0 ? n : 30) * 60
}
function batchMax(): number {
  const n = Number(process.env.IMHUB_MEMORY_DISTILL_BATCH_MAX)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20
}
function isDistillerEnabled(): boolean {
  if (!isMemoryEnabled()) return false
  const raw = (process.env.IMHUB_MEMORY_DISTILL_ENABLED || '1').toLowerCase()
  // Honor the same opt-out vocabulary as persona.isMemoryEnabled ('off'
  // included) so IMHUB_MEMORY_DISTILL_ENABLED=off actually stops the pass
  // instead of the UI toggle and the runtime disagreeing.
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off'
}

/**
 * One distiller pass. The periodic tick processes every buffered user only
 * when idle (no active agent jobs); while busy it limits itself to users whose
 * oldest pending turn has crossed the staleness floor. A manual trigger passes
 * `force` to flush every buffered user regardless of load — otherwise the web
 * "Run now" button is a no-op on a continuously-busy bot (the distiller shares
 * the process with the agent jobs, so it is almost never idle). Returns the
 * number of users processed.
 */
export async function runDistillerOnce(opts: { force?: boolean } = {}): Promise<number> {
  if (!isDistillerEnabled()) return 0
  if (status.running) return 0   // no overlapping passes (timer + manual trigger)
  status.running = true
  const flushAll = opts.force === true || _activeJobCount() === 0
  const users = flushAll ? listPendingUserKeys() : listPendingUserKeys({ olderThanSec: floorSec() })
  if (users.length === 0) {
    status.lastProcessed = 0
    status.running = false
    status.lastRunAt = Date.now()
    return 0
  }
  let processed = 0
  // Remember the last real problem so the web "Last error" tile can explain a
  // climbing pendingTotal. Cleared to null below only when nothing went wrong.
  let lastError: string | null = null
  try {
    for (const userKey of users) {
      const turns = listPendingForUser(userKey, batchMax())
      if (turns.length === 0) continue
      // Representative agent = the newest turn's agent (turns are id-ASC, so the
      // last one). Used by the zero-config 'auto' source.
      const representativeAgent = turns[turns.length - 1].agent_name || ''
      try {
        const r = await runBatchDistillation(
          userKey,
          turns.map((t) => ({ user_message: t.user_message, agent_reply: t.agent_reply })),
          representativeAgent,
        )
        if (r.ok) {
          // Processed (even if 0 facts were worth keeping) → clear these rows.
          deletePendingByIds(turns.map((t) => t.id))
          processed++
          log.info({ event: 'memory.distill.batch_done', userKey, turns: turns.length, saved: r.saved })
        } else {
          // No usable LLM — leave buffered, retry next pass (bounded by the
          // per-user cap enforced at enqueue time). Surface it so the operator
          // sees why distillation is stalled.
          lastError = 'no usable extraction LLM (check distillation source / agent / distill role)'
          log.debug({ event: 'memory.distill.batch_skipped', userKey, turns: turns.length })
        }
      } catch (err) {
        lastError = String(err)
        log.warn({ event: 'memory.distill.batch_failed', userKey, err: String(err) })
      }
    }
    status.lastProcessed = processed
    status.lastError = lastError
    return processed
  } finally {
    status.running = false
    status.lastRunAt = Date.now()
  }
}

/** Start the periodic distiller. No-op if already running. */
export function startMemoryDistiller(): void {
  if (timer) return
  const period = intervalMs()
  log.info({ event: 'memory.distill.scheduler_start', periodMs: period })
  timer = setInterval(() => {
    if (!isDistillerEnabled()) return
    void runDistillerOnce().catch((err) => log.warn({ event: 'memory.distill.tick_failed', err: String(err) }))
  }, period)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as { unref: () => void }).unref()
  }
}

/** Stop the periodic distiller (tests + graceful shutdown). */
export function stopMemoryDistiller(): void {
  if (timer) { clearInterval(timer); timer = null }
}
