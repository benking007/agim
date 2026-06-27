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
import { listPendingUserKeys, listPendingForUser, deletePendingByIds } from './memory.js'
import { runBatchDistillation } from './memory-distill.js'

const log = rootLogger.child({ component: 'memory-distiller' })
let timer: ReturnType<typeof setInterval> | null = null

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
  return raw !== '0' && raw !== 'false' && raw !== 'no'
}

/**
 * One distiller pass. When idle (no active agent jobs) processes every user
 * with buffered turns; when busy, only users whose oldest pending turn has
 * crossed the staleness floor. Returns the number of users processed.
 */
export async function runDistillerOnce(): Promise<number> {
  if (!isDistillerEnabled()) return 0
  const idle = _activeJobCount() === 0
  const users = idle ? listPendingUserKeys() : listPendingUserKeys({ olderThanSec: floorSec() })
  if (users.length === 0) return 0
  let processed = 0
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
        // per-user cap enforced at enqueue time).
        log.debug({ event: 'memory.distill.batch_skipped', userKey, turns: turns.length })
      }
    } catch (err) {
      log.warn({ event: 'memory.distill.batch_failed', userKey, err: String(err) })
    }
  }
  return processed
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
