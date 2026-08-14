/**
 * Step Reflect (步思) — L2 beat strategy for Agim Agent.
 *
 * After a mutating act (write / exec / call_agent), inject a soft ephemeral
 * steer so the next assistant hop emits a short fence before further changes.
 * R1 is advisory only — no hard gate. R2 adds `agim_reflect` + evaluateStepReflectGate.
 *
 * Env: AGIM_STEP_REFLECT=on|off|disabled (default off).
 * Session: session.stepReflect true|false overrides env (both persist).
 */

import { canonicalizeToolName } from './tool-names.js'
import { isTodoGateExemptTool } from './todo-gate.js'

export const STEP_REFLECT_STEER_PREFIX = '[step-reflect]'

export type StepReflectEnv = 'on' | 'off' | 'disabled'
export type StepReflectStance = 'keep' | 'adjust' | 'stop'

export interface StepReflectRecord {
  stance: StepReflectStance
  next: string
  at: number
}

export interface ParsedStepReflect {
  observed: string
  stance: StepReflectStance
  next: string
  risk?: string
}

const STANCES = new Set<StepReflectStance>(['keep', 'adjust', 'stop'])

export function resolveStepReflectEnv(): StepReflectEnv {
  const raw = (process.env.AGIM_STEP_REFLECT ?? '').toLowerCase().trim()
  if (raw === 'disabled' || raw === 'disable') return 'disabled'
  if (raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes') return 'on'
  return 'off'
}

export function isStepReflectDisabled(): boolean {
  return resolveStepReflectEnv() === 'disabled'
}

/** Effective on/off for this session. `disabled` always wins. */
export function isStepReflectEnabled(session?: { stepReflect?: boolean } | null): boolean {
  if (isStepReflectDisabled()) return false
  if (session?.stepReflect === true) return true
  if (session?.stepReflect === false) return false
  return resolveStepReflectEnv() === 'on'
}

/** Read / ask / todo / reserved `agim_reflect` skip the pending-reflect beat. */
export function isStepReflectExemptTool(toolName: string): boolean {
  if (!toolName) return false
  const canon = canonicalizeToolName(toolName)
  if (canon === 'agim_reflect' || toolName === 'agim_reflect') return true
  return isTodoGateExemptTool(toolName)
}

/** True when any tool in this act is not exempt (write / exec / call_agent / …). */
export function actNeedsReflect(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => name && !isStepReflectExemptTool(name))
}

const FENCE_RE = /<!--\s*step-reflect\s*-->([\s\S]*?)<!--\s*\/step-reflect\s*-->/i

function field(block: string, key: string): string {
  const re = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(.*)$`, 'im')
  const m = block.match(re)
  return m?.[1]?.trim() ?? ''
}

export function parseStepReflectFence(text: string): ParsedStepReflect | null {
  if (!text) return null
  const m = text.match(FENCE_RE)
  if (!m?.[1]) return null
  const body = m[1]
  const stanceRaw = field(body, 'stance').toLowerCase()
  if (!STANCES.has(stanceRaw as StepReflectStance)) return null
  const next = field(body, 'next')
  if (!next) return null
  const observed = field(body, 'observed')
  const risk = field(body, 'risk')
  return {
    observed,
    stance: stanceRaw as StepReflectStance,
    next,
    ...(risk ? { risk } : {}),
  }
}

/** Pull plain text from a pi / OpenAI-style assistant content payload. */
export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { type?: unknown; text?: unknown }
    if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text)
  }
  return parts.join('\n')
}

export function formatStepReflectSteer(): string {
  return [
    STEP_REFLECT_STEER_PREFIX,
    'The last act used a mutating tool (write / edit / exec / call_agent).',
    'Before the next mutating tool, emit this fence, then continue:',
    '',
    '<!-- step-reflect -->',
    'observed: <what the last act changed or revealed>',
    'stance: keep | adjust | stop',
    'next: <one-line next action>',
    'risk: <optional>',
    '<!-- /step-reflect -->',
    '',
    'Skip the fence if this turn is finished and you will not call another mutating tool.',
    'Do not call a mutating tool on this beat before the fence.',
  ].join('\n')
}

/** Append incoming reflects onto a step; keep the last 3 (R1 carousel). */
export function mergeStepReflects(
  prev: readonly StepReflectRecord[] | undefined,
  incoming: readonly StepReflectRecord[] | undefined,
): StepReflectRecord[] | undefined {
  if (!incoming?.length) return prev ? [...prev] : undefined
  const out = prev ? [...prev] : []
  for (const rec of incoming) {
    if (!rec || !STANCES.has(rec.stance) || !rec.next) continue
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : Date.now()
    if (out.some((x) => x.at === at && x.next === rec.next && x.stance === rec.stance)) continue
    out.push({ stance: rec.stance, next: rec.next.trim(), at })
  }
  return out.length > 0 ? out.slice(-3) : undefined
}
