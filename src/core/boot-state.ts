// boot-state — module-level tracker for "where are we in startup?".
//
// /api/service/status returns the phase so the web console's restart
// polling can wait for `ready` (everything wired) instead of just
// `web_ready` (HTTP server bound, but messengers / a2a not yet up).
//
// Phases progress strictly forward; never roll back:
//
//   starting          — process started, before any subsystem is up
//   web_ready         — HTTP server bound to port (browser can connect)
//   messengers_loading — adapters registered, .start() in flight
//   ready             — every adapter resolved .start(); processRestartPending
//                       done; ok to send / receive IM messages
//
// On graceful shutdown we don't roll back; the process exits before
// anyone cares to read.

import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'boot-state' })

export type BootPhase = 'starting' | 'web_ready' | 'messengers_loading' | 'ready'

const ORDER: BootPhase[] = ['starting', 'web_ready', 'messengers_loading', 'ready']

let currentPhase: BootPhase = 'starting'
const phaseStarts: Partial<Record<BootPhase, number>> = { starting: Date.now() }
const phaseDurations: Partial<Record<BootPhase, number>> = {}

export function getBootPhase(): BootPhase {
  return currentPhase
}

export function getBootInfo(): {
  phase: BootPhase
  startedAt: number
  msSinceStart: number
  phaseTimings: Partial<Record<BootPhase, number>>
} {
  const startedAt = phaseStarts.starting ?? Date.now()
  return {
    phase: currentPhase,
    startedAt,
    msSinceStart: Date.now() - startedAt,
    phaseTimings: { ...phaseDurations },
  }
}

/**
 * Advance to `phase`. Idempotent — re-setting the current phase is a
 * no-op. Going backward (e.g. setting 'starting' after 'ready') is
 * also a no-op + warn (would only happen on programmer error).
 */
export function setBootPhase(phase: BootPhase): void {
  const cur = ORDER.indexOf(currentPhase)
  const next = ORDER.indexOf(phase)
  if (next < 0) {
    log.warn({ event: 'boot.invalid_phase', phase })
    return
  }
  if (next === cur) return
  if (next < cur) {
    log.warn({ event: 'boot.backward_phase', from: currentPhase, to: phase })
    return
  }
  // Record duration of the phase we're leaving (from its start, if known).
  const now = Date.now()
  const startOfLeaving = phaseStarts[currentPhase]
  if (typeof startOfLeaving === 'number') {
    phaseDurations[currentPhase] = now - startOfLeaving
  }
  log.info({
    event: 'boot.phase',
    from: currentPhase,
    to: phase,
    leavingDurationMs: phaseDurations[currentPhase] ?? null,
  })
  currentPhase = phase
  phaseStarts[phase] = now
}

/** Test helper — reset to 'starting'. */
export function _resetBootStateForTests(): void {
  currentPhase = 'starting'
  for (const k of ORDER) {
    delete phaseStarts[k]
    delete phaseDurations[k]
  }
  phaseStarts.starting = Date.now()
}
