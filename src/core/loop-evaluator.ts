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
