// loop-scheduler — scheduled / cron-triggered Loop wake-ups (R6, minimal cut).
//
// Why exist:
//   - Loop's state machine (loop-run.ts) has no internal ticker: every round
//     is driven by the parent agent's tools inside ONE agent turn, and turns
//     are only triggered by user messages. Heartbeat / cron / schedule /
//     reminders therefore could never start a Loop (they only make one-shot
//     tool-less agent calls).
//   - This module is the missing wiring: it creates a Loop from a plain text
//     mission (objective + exit conditions), makes sure the sticky agent can
//     parent it (Agim Agent), then starts a parent turn via the exported
//     callAgentWithHistory so runAgentLoop drives planning → dispatch →
//     verdict inside that single turn.
//
// Usage: schedules whose prompt starts with the `loop:` prefix take this
// path instead of the plain job path (see schedule.ts fireSchedule). Example
// cron prompt:
//
//   loop: 修好登录超时；退出条件为验收通过或最多5轮
//
// R6 contract (loop-engineering.md): the trigger only starts (or resumes)
// a turn. It does NOT call confirmLoopMission. Incomplete mission text
// fails the fire and rolls back so a hidden cron thread cannot wedge
// forever in ALIGNING. Both hard fields in the cron prompt let startLoop
// enter planning on its own (same as `/loop start` with a complete line).
//
// Headless (unattended) mode is opt-in per mission: the text must contain
// 无人值守 / headless. AGIM_LOOP_HEADLESS=1 only applies to scheduled
// runs (source=scheduled), never to interactive chat Loops.

import { randomUUID } from 'node:crypto'
import { registry } from './registry.js'
import { sessionManager } from './session.js'
import { createLogger } from './logger.js'
import { canParentLoop } from './loop-parent-agent.js'
import { isAgentAvailableCached } from './onboarding.js'
import { isLoopParentTurnActive } from './loop-parent-turn.js'
import {
  startLoop,
  getActiveLoop,
  stopLoop,
  missionMentionsHeadless,
  type LoopRun,
} from './loop-run.js'
import { callAgentWithHistory } from './router.js'
import type { RouteContext } from './router.js'
import type { Logger } from 'pino'

const log: Logger = createLogger({ component: 'loop-scheduler' })

/** Prefix that marks a schedule prompt as a Loop wake-up (schedule.ts). */
export const LOOP_PROMPT_PREFIX = 'loop:'

/** Default cap on one scheduled parent turn (override via AGIM_LOOP_WAKE_TIMEOUT_MS). */
const DEFAULT_WAKE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * True when a schedule prompt should wake a Loop instead of running a plain
 * job. Accepts an optional leading label (`loop:` / `loop:`+space) and is
 * case-insensitive.
 */
export function isLoopSchedulePrompt(prompt: string): boolean {
  return /^loop\s*[：:]/i.test((prompt || '').trim())
}

/** Strip the `loop:` prefix, returning the mission text ('' when absent). */
export function loopMissionText(prompt: string): string {
  const trimmed = (prompt || '').trim()
  const m = /^loop\s*[：:]\s*/i.exec(trimmed)
  return m ? trimmed.slice(m[0].length).trim() : ''
}

/**
 * Keyword-only headless probe for cron text (no process-global env).
 * Env AGIM_LOOP_HEADLESS is applied later on the persisted run when
 * `source === 'scheduled'` — see `isLoopHeadless` in loop-run.ts.
 */
export function isHeadlessLoop(missionText: string): boolean {
  return missionMentionsHeadless(missionText)
}

export interface WakeLoopInput {
  platform: string
  channelId: string
  threadId: string
  /** IM userId of the originator; used for focus/session attribution. */
  userId: string
  /** Mission text WITHOUT the `loop:` prefix (objective；退出：…). */
  missionText: string
  /** Optional abort (Job Board signal / wake timeout). */
  signal?: AbortSignal
  /** Optional logger override (tests / callers with their own context). */
  logger?: Logger
}

export type WakeLoopResult =
  | { ok: true; run: LoopRun; started: boolean; skipped: boolean; resumed: boolean }
  | { ok: false; error: string }

function resolveWakeTimeoutMs(): number {
  const raw = (process.env.AGIM_LOOP_WAKE_TIMEOUT_MS ?? '').trim()
  if (!raw) return DEFAULT_WAKE_TIMEOUT_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAKE_TIMEOUT_MS
  return n
}

function rollbackFreshRun(
  input: WakeLoopInput,
  createdThisWake: boolean,
): void {
  if (!createdThisWake) return
  try {
    stopLoop(input.platform, input.channelId, input.threadId, 'error')
  } catch {
    /* last resort — do not hide the original error */
  }
}

/**
 * Create (or resume) a Loop for a thread from a plain-text mission and start
 * one parent turn so the Loop actually makes progress without a user message.
 *
 * Steps:
 *   1. Refuse empty / incomplete mission text (R6: do not auto-confirm).
 *   2. If a Loop is already active:
 *        - parent turn in-flight or pending_user_confirm → skip
 *        - aligning leftover → stop it, then start fresh
 *        - planning / dispatching / verifying / reflecting → resume one turn
 *   3. startLoop({ source: 'scheduled' }); aligning → rollback + error.
 *   4. Ensure the sticky agent can parent the Loop (switch to Agim if not).
 *   5. callAgentWithHistory() with a timeout; the injected Loop snippet +
 *      full Agim toolset drive planning → dispatch → verdict in-turn.
 *
 * Never throws; caller-facing errors are `{ ok:false }`. A run created in
 * THIS wake is rolled back on any failure after startLoop.
 */
export async function wakeLoopForThread(input: WakeLoopInput): Promise<WakeLoopResult> {
  const l = input.logger ?? log
  const text = (input.missionText || '').trim()
  if (!text) return { ok: false, error: 'empty mission text' }

  // Preconditions BEFORE creating a run — otherwise a missing agent leaves
  // an aligning/planning Loop that wedges every later tick (already_running).
  const agimAgent = registry.findAgent('agim')
  if (!agimAgent) return { ok: false, error: 'Agim Agent not registered' }
  if (!(await isAgentAvailableCached(agimAgent.name))) {
    return { ok: false, error: 'Agim Agent unavailable (no LLM backend configured)' }
  }

  const existing = getActiveLoop(input.platform, input.channelId, input.threadId)
  let createdThisWake = false
  let started = false
  let resumed = false
  let run!: LoopRun

  if (existing) {
    if (isLoopParentTurnActive(input.platform, input.channelId, input.threadId)) {
      l.info({
        event: 'loop-scheduler.skip_parent_active',
        platform: input.platform,
        threadId: input.threadId,
      }, 'loop parent turn already in-flight; scheduled wake-up skipped')
      return { ok: true, run: existing, started: false, skipped: true, resumed: false }
    }
    if (existing.status === 'pending_user_confirm') {
      l.info({
        event: 'loop-scheduler.skip_pending_confirm',
        platform: input.platform,
        threadId: input.threadId,
      }, 'loop waiting for user confirm; scheduled wake-up skipped')
      return { ok: true, run: existing, started: false, skipped: true, resumed: false }
    }
    if (existing.status === 'aligning') {
      // Leftover from a previous incomplete fire (or a human /loop start).
      // Do not auto-confirm. Clear it so this tick can start cleanly or fail.
      stopLoop(input.platform, input.channelId, input.threadId, 'error')
    } else {
      run = existing
      resumed = true
    }
  }

  if (!resumed) {
    const startedResult = startLoop({
      platform: input.platform,
      channelId: input.channelId,
      threadId: input.threadId,
      userId: input.userId,
      text,
      source: 'scheduled',
    })
    if (!startedResult.ok) {
      return { ok: false, error: startedResult.error }
    }
    createdThisWake = true
    started = true
    run = startedResult.run
    if (!startedResult.aligned || run.status === 'aligning') {
      rollbackFreshRun(input, true)
      return { ok: false, error: 'incomplete_mission' }
    }
  }

  let session: Awaited<ReturnType<typeof sessionManager.getOrCreateSession>>
  try {
    session = await sessionManager.getOrCreateSession(
      input.platform, input.channelId, input.threadId, agimAgent.name,
    )
  } catch (err) {
    rollbackFreshRun(input, createdThisWake)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!canParentLoop(session.agent)) {
    rollbackFreshRun(input, createdThisWake)
    return { ok: false, error: `sticky agent ${session.agent} cannot parent a Loop` }
  }

  const timeoutMs = resolveWakeTimeoutMs()
  const wakeCtrl = new AbortController()
  const onExternalAbort = () => wakeCtrl.abort()
  if (input.signal) {
    if (input.signal.aborted) wakeCtrl.abort()
    else input.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => wakeCtrl.abort(), timeoutMs)

  const ctx: RouteContext = {
    platform: input.platform,
    channelId: input.channelId,
    threadId: input.threadId,
    defaultAgent: agimAgent.name,
    traceId: `loop-${randomUUID().slice(0, 8)}`,
    logger: l,
    userId: input.userId,
    intent: 'loop-scheduled',
    signal: wakeCtrl.signal,
  }
  const turnPrompt = [
    '⏰ 定时任务已触发。',
    `使命：${text.slice(0, 500)}`,
    '',
    '请按当前 Loop 使命立即行动：先拆解任务并 call_agents 派子代理，',
    '子代理完成后调用 loop_verdict 验收。',
    '若已验收达标（met=true）请调用 loop_verdict 结束。',
  ].join('\n')

  l.info({
    event: 'loop-scheduler.wake',
    platform: input.platform,
    threadId: input.threadId,
    loopId: run!.id.slice(0, 8),
    headless: isHeadlessLoop(text),
    resumed,
    timeoutMs,
  }, resumed
    ? 'scheduled Loop wake-up: resuming parent turn'
    : 'scheduled Loop wake-up: starting parent turn')

  try {
    const generator = await callAgentWithHistory(
      agimAgent, session.id, turnPrompt, session.messages, ctx,
      session.model, session.variant, session.planMode,
    )
    for await (const _chunk of generator) {
      if (wakeCtrl.signal.aborted) break
    }
  } catch (err) {
    rollbackFreshRun(input, createdThisWake)
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onExternalAbort)
  }

  const after = getActiveLoop(input.platform, input.channelId, input.threadId)
  if (!after) {
    l.info({ event: 'loop-scheduler.wake.ended_in_turn', threadId: input.threadId },
      'Loop ended during the wake-up turn')
    return { ok: true, run: run!, started, skipped: false, resumed }
  }
  return { ok: true, run: after, started, skipped: false, resumed }
}
