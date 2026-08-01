/**
 * Capability profiles for Agim llmBackends (same-family Subagent via backend=).
 *
 * CLI specialty lives in agent-profiles.ts; backends get a parallel matrix so
 * Agim can prefer e.g. deepseek-v4-pro for 金融/中文长文 vs codex for 编码.
 *
 * Defaults are inferred from backend name + model id; operators override via
 * `config.backendProfiles` (sparse, keyed by llmBackends.name).
 */

import {
  type CapabilityMap,
  type CapabilityNotes,
  NEUTRAL_CAPABILITIES,
  capabilityNotesEqual,
  capabilitiesEqual,
  formatCapabilitiesCompact,
  normalizeCapabilityMap,
  normalizeCapabilityNotes,
} from './capability-dims.js'
import { getLiveConfig } from './live-config.js'
import { listProviders } from './llm/registry.js'

export interface BackendProfile {
  /** One-line specialty for catalog / Settings. */
  summary: string
  capabilities: CapabilityMap
  capabilityNotes?: CapabilityNotes
}

/** Sparse override/input — capabilities may omit dims (filled from inference). */
export type BackendProfilePatch = Omit<Partial<BackendProfile>, 'capabilities'> & {
  capabilities?: Partial<CapabilityMap>
}

export type BackendProfileOverrides = Record<string, BackendProfilePatch>

/** Heuristic defaults when name/model looks like a known family. */
export function inferBackendProfile(opts: {
  name: string
  model?: string
  provider?: string
}): BackendProfile {
  const blob = `${opts.name} ${opts.model || ''} ${opts.provider || ''}`.toLowerCase()

  if (/deepseek/.test(blob)) {
    return {
      summary: '中文与金融向强模型：长文写作、金融分析、多步推理；编码中等。',
      capabilities: {
        coding: 'medium',
        finance: 'strong',
        zhWriting: 'strong',
        reasoning: 'strong',
        dataCheck: 'strong',
      },
      capabilityNotes: {
        finance: '中文金融语料丰富',
        zhWriting: '母语级',
      },
    }
  }

  if (/kimi|moonshot|qwen|通义|glm|chatglm|minimax|yi-/.test(blob)) {
    return {
      summary: '中文友好通用模型：中文写作与推理较强；编码中等偏上。',
      capabilities: {
        coding: 'medium',
        finance: 'medium',
        zhWriting: 'strong',
        reasoning: 'strong',
        dataCheck: 'medium',
      },
      capabilityNotes: {
        zhWriting: '中文语料友好',
      },
    }
  }

  if (/claude|anthropic|opus|sonnet/.test(blob)) {
    return {
      summary: '强推理与工程向：编码/重构、多步推理、数据校验；中文长文中等。',
      capabilities: {
        coding: 'strong',
        finance: 'medium',
        zhWriting: 'medium',
        reasoning: 'strong',
        dataCheck: 'strong',
      },
      capabilityNotes: {
        finance: '非专长',
        zhWriting: '翻译腔可能明显',
      },
    }
  }

  if (/gpt|openai|o[13]|o4|codex/.test(blob)) {
    return {
      summary: '工程与推理向通用模型：编码/重构与多步推理强；中文长文中等。',
      capabilities: {
        coding: 'strong',
        finance: 'medium',
        zhWriting: 'medium',
        reasoning: 'strong',
        dataCheck: 'strong',
      },
    }
  }

  if (/flash|lite|mini|haiku|cheap|small/.test(blob)) {
    return {
      summary: '廉价/快速后端：适合只读探索与轻量摘要；重编码与深度金融分析慎用。',
      capabilities: {
        coding: 'weak',
        finance: 'weak',
        zhWriting: 'medium',
        reasoning: 'medium',
        dataCheck: 'medium',
      },
    }
  }

  return {
    summary: '已配置的 Agim backend（无内置家族启发式时用中性评分）。',
    capabilities: { ...NEUTRAL_CAPABILITIES },
  }
}

export function normalizeBackendProfile(
  raw: BackendProfilePatch | null | undefined,
  fallback: BackendProfile,
): BackendProfile {
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 500) : ''
  const capabilities = normalizeCapabilityMap(
    raw?.capabilities,
    fallback.capabilities,
  )
  const notesRaw = raw?.capabilityNotes !== undefined
    ? normalizeCapabilityNotes(raw.capabilityNotes)
    : normalizeCapabilityNotes(fallback.capabilityNotes)
  return {
    summary: summary || fallback.summary,
    capabilities,
    ...(Object.keys(notesRaw).length > 0 ? { capabilityNotes: notesRaw } : {}),
  }
}

export function readBackendProfileOverrides(config: unknown): BackendProfileOverrides {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const raw = (config as { backendProfiles?: unknown }).backendProfiles
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: BackendProfileOverrides = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim()
    if (!name) continue
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue
    out[name] = val as BackendProfilePatch
  }
  return out
}

export function resolveBackendProfile(
  backend: { name: string; model?: string; provider?: string },
  overrides?: BackendProfileOverrides | null,
): BackendProfile {
  const inferred = inferBackendProfile(backend)
  const over = overrides?.[backend.name]
  return normalizeBackendProfile(over, inferred)
}

export function backendProfilesEqual(a: BackendProfile, b: BackendProfile): boolean {
  return (
    a.summary === b.summary
    && capabilitiesEqual(a.capabilities, b.capabilities)
    && capabilityNotesEqual(a.capabilityNotes || {}, b.capabilityNotes || {})
  )
}

/** Persist only backends that differ from inference defaults. */
export function backendProfileOverridesFromEffective(
  effective: Record<string, BackendProfile>,
  backends: Array<{ name: string; model?: string; provider?: string }>,
): BackendProfileOverrides {
  const out: BackendProfileOverrides = {}
  for (const b of backends) {
    const cur = effective[b.name]
    if (!cur) continue
    const inferred = inferBackendProfile(b)
    if (backendProfilesEqual(cur, inferred)) continue
    out[b.name] = {
      summary: cur.summary,
      capabilities: { ...cur.capabilities },
      ...(cur.capabilityNotes && Object.keys(cur.capabilityNotes).length > 0
        ? { capabilityNotes: { ...cur.capabilityNotes } }
        : {}),
    }
  }
  return out
}

export function formatBackendProfilesForPrompt(
  backends: Array<{ name: string; model?: string; provider?: string }>,
  overrides?: BackendProfileOverrides | null,
): string {
  if (backends.length === 0) return ''
  const lines: string[] = [
    'Agim same-family backends (pick backend="<name>" on call_agent(s); Agim stays parent):',
  ]
  for (const b of backends) {
    const p = resolveBackendProfile(b, overrides)
    const caps = formatCapabilitiesCompact(p.capabilities, p.capabilityNotes)
    lines.push(`- backend ${b.name}: ${p.summary} | caps: ${caps}`)
  }
  return lines.join('\n')
}

/** Live backend catalog from registry + config overrides. */
export function getBackendProfilesCatalogForPrompt(): string {
  try {
    const cfg = getLiveConfig()
    const overrides = readBackendProfileOverrides(cfg)
    const providers = listProviders()
    const backends = providers.map((p) => ({
      name: p.name,
      model: p.model,
      provider: p.providerType,
    }))
    return formatBackendProfilesForPrompt(backends, overrides)
  } catch {
    return ''
  }
}
