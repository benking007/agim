/**
 * Structured capability dimensions for Subagent dispatch.
 *
 * Free-text strengths/avoid stay useful; these dims give Agim a comparable
 * matrix across CLI agents (codex, …) and same-family Agim backends
 * (deepseek-v4-pro, …) so finance / 中文长文 / coding 不会被糊成一句「会写代码」。
 */

export const CAPABILITY_DIMS = [
  'coding',
  'finance',
  'zhWriting',
  'reasoning',
  'dataCheck',
] as const

export type CapabilityDim = (typeof CAPABILITY_DIMS)[number]

export const CAPABILITY_LEVELS = ['strong', 'medium', 'weak'] as const
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number]

export type CapabilityMap = Record<CapabilityDim, CapabilityLevel>
export type CapabilityNotes = Partial<Record<CapabilityDim, string>>

/** Short labels for Settings / docs (zh). */
export const CAPABILITY_DIM_LABELS_ZH: Record<CapabilityDim, string> = {
  coding: '编码/重构',
  finance: '金融分析',
  zhWriting: '中文长文写作',
  reasoning: '多步推理',
  dataCheck: '数据校验',
}

/** Short labels for Settings / docs (en). */
export const CAPABILITY_DIM_LABELS_EN: Record<CapabilityDim, string> = {
  coding: 'Coding / refactor',
  finance: 'Finance analysis',
  zhWriting: 'Chinese long-form',
  reasoning: 'Multi-step reasoning',
  dataCheck: 'Data validation',
}

export const CAPABILITY_LEVEL_LABELS_ZH: Record<CapabilityLevel, string> = {
  strong: '强',
  medium: '中',
  weak: '弱',
}

export const CAPABILITY_LEVEL_LABELS_EN: Record<CapabilityLevel, string> = {
  strong: 'strong',
  medium: 'medium',
  weak: 'weak',
}

/** Neutral baseline when nothing is known. */
export const NEUTRAL_CAPABILITIES: CapabilityMap = {
  coding: 'medium',
  finance: 'medium',
  zhWriting: 'medium',
  reasoning: 'medium',
  dataCheck: 'medium',
}

export function isCapabilityDim(v: unknown): v is CapabilityDim {
  return typeof v === 'string' && (CAPABILITY_DIMS as readonly string[]).includes(v)
}

export function isCapabilityLevel(v: unknown): v is CapabilityLevel {
  return typeof v === 'string' && (CAPABILITY_LEVELS as readonly string[]).includes(v)
}

export function normalizeCapabilityMap(
  raw: Partial<CapabilityMap> | null | undefined,
  fallback: CapabilityMap = NEUTRAL_CAPABILITIES,
): CapabilityMap {
  const out: CapabilityMap = { ...fallback }
  if (!raw || typeof raw !== 'object') return out
  for (const dim of CAPABILITY_DIMS) {
    const v = raw[dim]
    if (isCapabilityLevel(v)) out[dim] = v
  }
  return out
}

export function normalizeCapabilityNotes(
  raw: CapabilityNotes | null | undefined,
): CapabilityNotes {
  if (!raw || typeof raw !== 'object') return {}
  const out: CapabilityNotes = {}
  for (const dim of CAPABILITY_DIMS) {
    const v = raw[dim]
    if (typeof v !== 'string') continue
    const s = v.trim().slice(0, 80)
    if (s) out[dim] = s
  }
  return out
}

export function capabilitiesEqual(a: CapabilityMap, b: CapabilityMap): boolean {
  return CAPABILITY_DIMS.every((d) => a[d] === b[d])
}

export function capabilityNotesEqual(a: CapabilityNotes, b: CapabilityNotes): boolean {
  for (const dim of CAPABILITY_DIMS) {
    if ((a[dim] || '') !== (b[dim] || '')) return false
  }
  return true
}

/**
 * Compact wire form for prompts:
 * `coding=strong finance=medium(非专长) zhWriting=medium …`
 */
export function formatCapabilitiesCompact(
  caps: CapabilityMap,
  notes?: CapabilityNotes,
): string {
  return CAPABILITY_DIMS.map((dim) => {
    const note = notes?.[dim]?.trim()
    return note ? `${dim}=${caps[dim]}(${note})` : `${dim}=${caps[dim]}`
  }).join(' ')
}

/** One-line dim legend for the specialty catalog header. */
export function capabilityDimsLegend(): string {
  return (
    'Capability dims (strong|medium|weak): '
    + 'coding=编码/重构; finance=金融分析; zhWriting=中文长文; '
    + 'reasoning=多步推理; dataCheck=数据校验'
  )
}
