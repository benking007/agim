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
// Headless (unattended) mode: when AGIM_LOOP_HEADLESS=1 (or the mission text
// contains "无人值守"), a met=true verdict ends the Loop immediately instead
// of parking it in pending_user_confirm for a human. Explicit opt-in only —
// the interactive HITL default is preserved.

import { randomUUID } from 'node:crypto'
import { registry } from './registry.js'
import { sessionManager } from './session.js'
import { createLogger } from './logger.js'
import { canParentLoop } from './loop-parent-agent.js'
import { isAgentAvailableCached } from './onboarding.js'
import {
  startLoop,
  confirmLoopMission,
  getActiveLoop,
  setLoopObjective,
  setLoopExit,
  parseLoopStartText,
  type LoopRun,
} from './loop-run.js'
import { callAgentWithHistory } from './router.js'
import type { RouteContext } from './router.js'
import type { Logger } from 'pino'

const log: Logger = createLogger({ component: 'loop-scheduler' })

/** Prefix that marks a schedule prompt as a Loop wake-up (schedule.ts). */
export const LOOP_PROMPT_PREFIX = 'loop:'

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
 * Headless opt-in: AGIM_LOOP_HEADLESS=1, or the mission text explicitly says
 * 无人值守 / headless. When on, met=true verdicts auto-end the Loop instead
 * of parking in pending_user_confirm.
 */
export function isHeadlessLoop(missionText: string): boolean {
  const env = (process.env.AGIM_LOOP_HEADLESS ?? '').trim().toLowerCase()
  if (env === '1' || env === 'on' || env === 'true') return true
  return /无人值守|headless/i.test(missionText)
}

export interface WakeLoopInput {
  platform: string
  channelId: string
  threadId: string
  /** IM userId of the originator; used for focus/session attribution. */
  userId: string
  /** Mission text WITHOUT the `loop:` prefix (objective；退出：…). */
  missionText: string
  /** Optional explicit max rounds override (defaults to mission/exit text). */
  maxRounds?: number
  /** Optional wall-clock cap in ms (defaults to mission/exit text). */
  maxWallMs?: number
  /** Optional logger override (tests / callers with their own context). */
  logger?: Logger
}

export type WakeLoopResult =
  | { ok: true; run: LoopRun; started: boolean; skipped: boolean }
  | { ok: false; error: string }

/**
 * Create (or reuse) a Loop for a thread from a plain-text mission and start
 * one parent turn so the Loop actually makes progress without a user message.
 *
 * Steps (all reuse existing exports — no state-machine changes):
 *   1. startLoop() with the mission text; an already-active Loop returns
 *      'already_running' → skipped.
 *   2. If still aligning (missing fields), fill objective/exit and confirm.
 *   3. Ensure the sticky agent can parent the Loop (switch to Agim if not).
 *   4. callAgentWithHistory() on that session; the injected Loop snippet +
 *      full Agim toolset drive planning → dispatch → verdict in-turn.
 *
 * Never throws on Loop bookkeeping; caller-facing errors are returned as
 * { ok:false }. The agent turn may still throw — that propagates to the
 * caller (schedule.ts catches per-fire).
 */
export async function wakeLoopForThread(input: WakeLoopInput): Promise<WakeLoopResult> {
  const l = input.logger ?? log
  const text = (input.missionText || '').trim()
  if (!text) return { ok: false, error: 'empty mission text' }

  // 1. Start (or skip if already running on this thread).
  const started = startLoop({
    platform: input.platform,
    channelId: input.channelId,
    threadId: input.threadId,
    userId: input.userId,
    text,
  })
  if (!started.ok) {
    if (started.error === 'already_running') {
      l.info({
        event: 'loop-scheduler.skip_already_running',
        platform: input.platform,
        threadId: input.threadId,
      }, 'loop already active on thread; scheduled wake-up skipped')
      const active = getActiveLoop(input.platform, input.channelId, input.threadId)
      if (!active) {
        // Race: loop ended between startLoop's already_running check and now.
        return { ok: false, error: 'loop ended during wake-up' }
      }
      return { ok: true, run: active, started: false, skipped: true }
    }
    return { ok: false, error: started.error }
  }

  // 2. Align: fill any missing hard fields and confirm.
  if (!started.aligned || started.run.status === 'aligning') {
    const parsed = parseLoopStartText(text)
    if (parsed.objective) {
      const r = setLoopObjective(input.platform, input.channelId, input.threadId, parsed.objective)
      if (!r.ok && r.error !== 'not_aligning') {
        return { ok: false, error: `objective: ${r.error}` }
      }
    }
    if (parsed.exitDescription) {
      const r = setLoopExit(input.platform, input.channelId, input.threadId, parsed.exitDescription)
      if (!r.ok && r.error !== 'not_aligning') {
        return { ok: false, error: `exit: ${r.error}` }
      }
    }
    const confirmed = confirmLoopMission(input.platform, input.channelId, input.threadId)
    if (!confirmed.ok) {
      if (confirmed.error === 'not_aligning') {
        // Someone else confirmed between our startLoop and here — fine.
        l.debug({ event: 'loop-scheduler.confirm_race' }, 'mission confirmed concurrently')
      } else {
        return { ok: false, error: `confirm: ${confirmed.error}` }
      }
    }
  }

  // 3. Parent agent must be Agim Agent (Loop orchestration tools only exist
  //    there). getOrCreateSession with 'agim' idempotently switches.
  const agimAgent = registry.findAgent('agim')
  if (!agimAgent) return { ok: false, error: 'Agim Agent not registered' }
  if (!(await isAgentAvailableCached(agimAgent.name))) {
    return { ok: false, error: 'Agim Agent unavailable (no LLM backend configured)' }
  }
  const session = await sessionManager.getOrCreateSession(
    input.platform, input.channelId, input.threadId, agimAgent.name,
  )
  if (!canParentLoop(session.agent)) {
    return { ok: false, error: `sticky agent ${session.agent} cannot parent a Loop` }
  }

  // 4. One parent turn: the Loop snippet (buildLoopSnippet in router) tells
  //    the model the current phase; the full Agim toolset (call_agents /
  //    loop_verdict) lets runAgentLoop drive the round to completion.
  const ctx: RouteContext = {
    platform: input.platform,
    channelId: input.channelId,
    threadId: input.threadId,
    defaultAgent: agimAgent.name,
    traceId: `loop-${randomUUID().slice(0, 8)}`,
    logger: l,
    userId: input.userId,
    intent: 'loop-scheduled',
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
    loopId: started.run.id.slice(0, 8),
    headless: isHeadlessLoop(text),
  }, 'scheduled Loop wake-up: starting parent turn')

  try {
    const generator = await callAgentWithHistory(
      agimAgent, session.id, turnPrompt, session.messages, ctx,
      session.model, session.variant, session.planMode,
    )
    for await (const _chunk of generator) {
      // Drain the generator; the adapter persists to session history.
    }
  } finally {
    // The loop run may have ended (verdict) or be parked in a phase; nothing
    // to clean up here — writeRun owns persistence.
  }

  const run = getActiveLoop(input.platform, input.channelId, input.threadId)
  if (!run) {
    // Ended within this turn (e.g. headless met=true or wall limit).
    l.info({ event: 'loop-scheduler.wake.ended_in_turn', threadId: input.threadId },
      'Loop ended during the wake-up turn')
    return { ok: true, run: started.run, started: true, skipped: false }
  }
  return { ok: true, run, started: true, skipped: false }
}
