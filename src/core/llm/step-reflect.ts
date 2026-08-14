/**
 * Step Reflect (步思) — DeepSeek-style per-hop think-then-act for Agim Agent.
 *
 * When on, Agim forces the provider thinking channel (even if /think is off)
 * and surfaces each hop's reasoning as reflect activity while the harness
 * keeps calling tools. The HTML fence is a fallback for models with no
 * thinking trace — not the primary path.
 *
 * Env: AGIM_STEP_REFLECT=on|off|disabled (default off).
 * Session: session.stepReflect true|false overrides env (both persist).
 */

import { canonicalizeToolName } from './tool-names.js'
import { isTodoGateExemptTool } from './todo-gate.js'

export const STEP_REFLECT_STEER_PREFIX = '[step-reflect]'

export type StepReflectEnv = 'on' | 'off' | 'disabled'
export type StepReflectStance = 'keep' | 'adjust' | 'stop'
export type StepReflectThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

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

export type ThinkingStreamEvent =
  | { kind: 'start' }
  | { kind: 'delta'; delta: string }
  | { kind: 'end' }

const STANCES = new Set<StepReflectStance>(['keep', 'adjust', 'stop'])
const THINKING_NEXT_MAX = 80
const THINKING_OBSERVED_MAX = 240

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

/**
 * DeepSeek-style: step-reflect on + a reasoning-capable model forces at least
 * `high`. `/think high|max` still wins. Off when the backend cannot think.
 */
export function resolveStepReflectThinkingLevel(
  current: StepReflectThinkingLevel,
  opts: { enabled: boolean; modelReasoning: boolean },
): StepReflectThinkingLevel {
  if (!opts.enabled || !opts.modelReasoning) return current
  if (current === 'off' || current === 'minimal') return 'high'
  return current
}

/** Read / ask / todo / reserved `agim_reflect` skip the non-thinking fallback steer. */
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

/** Pull provider thinking / reasoning blocks (pi `{ type: 'thinking' }`). */
export function extractAssistantThinking(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { type?: unknown; thinking?: unknown; text?: unknown }
    if (rec.type !== 'thinking' && rec.type !== 'reasoning') continue
    if (typeof rec.thinking === 'string' && rec.thinking) parts.push(rec.thinking)
    else if (typeof rec.text === 'string' && rec.text) parts.push(rec.text)
  }
  return parts.join('')
}

export function classifyThinkingStreamEvent(ev: unknown): ThinkingStreamEvent | null {
  if (!ev || typeof ev !== 'object') return null
  const rec = ev as { type?: unknown; delta?: unknown }
  if (rec.type === 'thinking_start') return { kind: 'start' }
  if (rec.type === 'thinking_end') return { kind: 'end' }
  if (rec.type === 'thinking_delta' && typeof rec.delta === 'string' && rec.delta.length > 0) {
    return { kind: 'delta', delta: rec.delta }
  }
  return null
}

export function summarizeThinkingLine(thinking: string, max = THINKING_NEXT_MAX): string {
  const compact = thinking.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** Turn a thinking trace into a reflect card (stance is informational, not a gate). */
export function stepReflectFromThinking(thinking: string): ParsedStepReflect | null {
  const next = summarizeThinkingLine(thinking)
  if (!next) return null
  const observed = thinking.replace(/\s+/g, ' ').trim().slice(0, THINKING_OBSERVED_MAX)
  return { observed, stance: 'keep', next }
}

export function formatStepReflectSteer(): string {
  return [
    STEP_REFLECT_STEER_PREFIX,
    'This session is in step-think mode (DeepSeek-style ReAct).',
    'On every hop: think first (short), then call tools or answer the user.',
    'Keep thinking tight — one beat of reasoning, then act. Do not dump a long plan.',
    'If this provider has no thinking channel, write one line of next action before tools.',
  ].join('\n')
}

/** Append incoming reflects onto a step; same `at` updates in place (live hop). */
export function mergeStepReflects(
  prev: readonly StepReflectRecord[] | undefined,
  incoming: readonly StepReflectRecord[] | undefined,
): StepReflectRecord[] | undefined {
  if (!incoming?.length) return prev ? [...prev] : undefined
  const out = prev ? [...prev] : []
  for (const rec of incoming) {
    if (!rec || !STANCES.has(rec.stance) || !rec.next) continue
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : Date.now()
    const next = rec.next.trim()
    const idx = out.findIndex((x) => x.at === at)
    if (idx >= 0) {
      out[idx] = { stance: rec.stance, next, at }
      continue
    }
    if (out.some((x) => x.next === next && x.stance === rec.stance && x.at === at)) continue
    out.push({ stance: rec.stance, next, at })
  }
  return out.length > 0 ? out.slice(-3) : undefined
}
