// Independent Loop verifier — cheap second opinion before objective_met.
// Inspired by Claude Code goal evaluator; Agim uses same-family role=cheap.
// Knob: AGIM_LOOP_EVALUATOR=auto|on|off (default auto = try when cheap bound).

import { callAgentByName } from './a2a.js'
import { logger as rootLogger } from './logger.js'
import { getMissionView, noteLoopEvaluator, type LoopRun } from './loop-run.js'
import type { RouteContext } from './router.js'
import { resolveSubagentSpawn } from './subagent.js'

const log = rootLogger.child({ component: 'loop-evaluator' })

export type LoopEvaluatorMode = 'auto' | 'on' | 'off'

export function getLoopEvaluatorMode(): LoopEvaluatorMode {
  const raw = (process.env.AGIM_LOOP_EVALUATOR ?? 'auto').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 'off'
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') return 'on'
  return 'auto'
}

function parseAgreeJson(text: string): { agree: boolean; reason: string } | null {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fence?.[1] || trimmed).trim()
  const brace = candidate.match(/\{[\s\S]*\}/)
  if (!brace) return null
  try {
    const obj = JSON.parse(brace[0]!) as { agree?: unknown; reason?: unknown }
    if (typeof obj.agree !== 'boolean') return null
    return {
      agree: obj.agree,
      reason: typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 500) : '',
    }
  } catch {
    return null
  }
}

/**
 * Run independent evaluator before accepting stop+met=true.
 * - off → skip
 * - auto → skip if role=cheap unbound
 * - on → require cheap (or fail soft skip with reason)
 */
export async function evaluateLoopObjectiveMet(input: {
  run: LoopRun
  claimSummary: string
  callerAgent: string
  routeCtx: RouteContext
  signal?: AbortSignal
}): Promise<{
  proceed: boolean
  skipped: boolean
  agree?: boolean
  reason: string
}> {
  const mode = getLoopEvaluatorMode()
  if (mode === 'off') {
    noteLoopEvaluator(input.run.platform, input.run.channelId, input.run.threadId, {
      agree: true,
      reason: 'AGIM_LOOP_EVALUATOR=off',
      skipped: true,
    })
    return { proceed: true, skipped: true, reason: 'evaluator disabled' }
  }

  const spawn = resolveSubagentSpawn(
    { agent: 'agim', role: 'cheap', isolate: true },
    input.callerAgent,
  )
  if (!spawn.ok) {
    if (mode === 'auto') {
      noteLoopEvaluator(input.run.platform, input.run.channelId, input.run.threadId, {
        agree: true,
        reason: `cheap unbound: ${spawn.error}`,
        skipped: true,
      })
      return { proceed: true, skipped: true, reason: `evaluator skipped (${spawn.error})` }
    }
    noteLoopEvaluator(input.run.platform, input.run.channelId, input.run.threadId, {
      agree: false,
      reason: `evaluator required but unavailable: ${spawn.error}`,
    })
    return {
      proceed: false,
      skipped: false,
      agree: false,
      reason: `evaluator unavailable: ${spawn.error}`,
    }
  }

  const view = getMissionView(input.run)
  const prompt = [
    'You are an independent Loop verifier. Do NOT call tools. Reply with ONLY JSON:',
    '{"agree":boolean,"reason":"short"}',
    '',
    'Decide whether the claim that the OBJECTIVE is MET is justified.',
    'Disagree if evidence in the claim is weak, vague, or conflicts with Objective/Acceptance/Exit.',
    '',
    `Objective: ${view.objective}`,
    view.acceptance ? `Acceptance: ${view.acceptance}` : '',
    `Exit: ${view.exitDescription}`,
    `Claim summary: ${input.claimSummary}`,
  ].filter(Boolean).join('\n')

  log.info({
    event: 'loop.evaluator.start',
    loopId: input.run.id,
    label: spawn.label,
    threadId: input.run.threadId,
  }, 'running independent loop evaluator')

  const result = await callAgentByName(spawn.agent, prompt, input.routeCtx, {
    callerDepth: 0,
    callerAgent: input.callerAgent,
    isolate: true,
    ...(spawn.model ? { model: spawn.model } : {}),
    activityLabel: `${spawn.label}/loop-eval`,
    signal: input.signal,
  })

  if (!result.ok) {
    // Fail-open on infra errors so a flaky cheap model does not trap the Loop
    const reason = `evaluator call failed: ${result.error || 'unknown'}`
    noteLoopEvaluator(input.run.platform, input.run.channelId, input.run.threadId, {
      agree: true,
      reason,
      skipped: true,
    })
    return { proceed: true, skipped: true, reason }
  }

  const parsed = parseAgreeJson(result.result || '')
  if (!parsed) {
    const reason = 'evaluator returned non-JSON; treating as skip'
    noteLoopEvaluator(input.run.platform, input.run.channelId, input.run.threadId, {
      agree: true,
      reason,
      skipped: true,
    })
    return { proceed: true, skipped: true, reason }
  }

  noteLoopEvaluator(input.run.platform, input.run.channelId, input.run.threadId, {
    agree: parsed.agree,
    reason: parsed.reason || (parsed.agree ? 'agree' : 'disagree'),
  })

  if (!parsed.agree) {
    return {
      proceed: false,
      skipped: false,
      agree: false,
      reason: parsed.reason || 'independent evaluator disagreed',
    }
  }
  return {
    proceed: true,
    skipped: false,
    agree: true,
    reason: parsed.reason || 'agree',
  }
}

// ─── P1-1: AGIM_LOOP_AUTO_VERIFY — automatic verdict when the parent turn
// died before calling loop_verdict ───────────────────────────────────────
//
// `maybeReapIdleLoopVerify` (loop-verify-gate.ts) only knows how to STOP a
// Loop whose parent vanished mid-VERIFY (verify_skipped). With
// AGIM_LOOP_AUTO_VERIFY=1 the reaper instead runs a cheap same-family
// Subagent that reviews the round's Subagent results against the mission and
// PRODUCES the verdict the parent never did. applyLoopVerdict then advances
// the state machine normally: met=false → next planning round, met=true →
// ended (or pending_user_confirm in interactive mode).

export function isLoopAutoVerifyEnabled(): boolean {
  const raw = (process.env.AGIM_LOOP_AUTO_VERIFY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

interface AutoVerdict {
  met: boolean
  summary: string
  gaps?: string[]
  nextDirection?: string
}

function parseVerdictJson(text: string): AutoVerdict | null {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fence?.[1] || trimmed).trim()
  const brace = candidate.match(/\{[\s\S]*\}/)
  if (!brace) return null
  const raw = brace[0]
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as {
      met?: unknown
      summary?: unknown
      gaps?: unknown
      nextDirection?: unknown
    }
    if (typeof obj.met !== 'boolean') return null
    return {
      met: obj.met,
      summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 500) : '',
      ...(Array.isArray(obj.gaps)
        ? { gaps: obj.gaps.filter((g): g is string => typeof g === 'string').map((g) => g.slice(0, 200)).slice(0, 8) }
        : {}),
      ...(typeof obj.nextDirection === 'string' && obj.nextDirection.trim()
        ? { nextDirection: obj.nextDirection.trim().slice(0, 500) }
        : {}),
    }
  } catch {
    return null
  }
}

/** Format the current round's Subagent results for the reviewer prompt. */
function formatRoundEvidence(run: LoopRun): string {
  const ids = Array.isArray(run.roundJobIds) ? run.roundJobIds : []
  if (ids.length === 0) return '(no Subagent results recorded)'
  try {
    // Dynamic import keeps the static graph light; job-board is SQLite-backed
    // and may be unavailable (bun) — degrade to a line per job id.
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const lines: string[] = []
    for (const id of ids.slice(-12)) {
      lines.push(`- subagent job #${id}`)
    }
    return lines.join('\n')
  } catch {
    return `(subagent jobs: ${ids.join(', ')})`
  }
}

/**
 * Run one auto-verify round: ask a cheap same-family Subagent to review the
 * round's evidence against the mission and produce the loop_verdict payload.
 * Returns the parsed verdict, or null when the reviewer is unavailable /
 * returns unparseable JSON (caller falls back to verify_skipped).
 */
export async function autoVerifyLoopRound(input: {
  run: LoopRun
  callerAgent: string
  routeCtx: RouteContext
  signal?: AbortSignal
}): Promise<AutoVerdict | null> {
  const { run, routeCtx } = input
  const spawn = resolveSubagentSpawn(
    { agent: 'agim', role: 'cheap', isolate: true },
    input.callerAgent,
  )
  if (!spawn.ok) {
    log.warn({
      event: 'loop.auto_verify.spawn_unavailable',
      loopId: run.id,
      error: spawn.error,
      threadId: run.threadId,
    }, 'auto-verify skipped: cheap reviewer unavailable')
    return null
  }

  const view = getMissionView(run)
  const prompt = [
    'You are an independent Loop reviewer. Do NOT call tools. Reply with ONLY JSON:',
    '{"met":boolean,"summary":"short","gaps":["..."],"nextDirection":"..."}',
    '',
    `Objective: ${view.objective}`,
    view.acceptance ? `Acceptance: ${view.acceptance}` : '',
    `Exit: ${view.exitDescription}`,
    `Round: ${run.round}/${run.maxRounds}`,
    '',
    'Subagent results this round:',
    formatRoundEvidence(run),
    '',
    'met=true only when the evidence plausibly satisfies the Objective and Exit.',
    'met=false requires gaps[] and a concrete nextDirection for the next round.',
  ].filter(Boolean).join('\n')

  log.info({
    event: 'loop.auto_verify.start',
    loopId: run.id,
    label: spawn.label,
    threadId: run.threadId,
  }, 'running auto-verify reviewer for vanished parent turn')

  const result = await callAgentByName(spawn.agent, prompt, routeCtx, {
    callerDepth: 0,
    callerAgent: input.callerAgent,
    isolate: true,
    ...(spawn.model ? { model: spawn.model } : {}),
    activityLabel: `${spawn.label}/loop-auto-verify`,
    signal: input.signal,
  })

  if (!result.ok) {
    log.warn({
      event: 'loop.auto_verify.call_failed',
      loopId: run.id,
      error: result.error || 'unknown',
    }, 'auto-verify reviewer call failed')
    return null
  }

  const verdict = parseVerdictJson(result.result || '')
  if (!verdict) {
    log.warn({
      event: 'loop.auto_verify.bad_json',
      loopId: run.id,
    }, 'auto-verify reviewer returned non-JSON; falling back to verify_skipped')
    return null
  }

  noteLoopEvaluator(run.platform, run.channelId, run.threadId, {
    agree: verdict.met,
    reason: `auto-verify: ${verdict.summary || (verdict.met ? 'met' : 'not met')}`,
  })
  return verdict
}

export type { AutoVerdict }
