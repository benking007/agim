/**
 * Resolve + persist model/agent token prices.
 *
 * Lookup order for a turn: admin override → built-in preset → (LLM only)
 * caller-supplied backend rates / pi-ai catalog / global default, which
 * live in `estimateChargeUsd`.
 */

import { mutateAccounts, readAccounts } from './accounts-store.js'
import {
  CLI_AGENT_FALLBACK_PRICE,
  CLI_AGENT_PRICE_PRESETS,
  LLM_PRICE_PRESETS,
  type TokenPrice,
} from './model-price-presets.js'

export type PriceKind = 'llm' | 'cli'
export type PriceSource = 'override' | 'preset' | 'fallback' | 'unset'

export interface ModelPriceRow {
  key: string
  kind: PriceKind
  id: string
  preset: TokenPrice | null
  current: TokenPrice
  source: PriceSource
}

export function llmPriceKey(modelId: string): string {
  return `llm:${modelId.trim()}`
}

export function agentPriceKey(agent: string): string {
  return `agent:${agent.trim()}`
}

export function parsePriceKey(key: string): { kind: PriceKind; id: string } | null {
  const trimmed = key.trim()
  if (trimmed.startsWith('llm:')) {
    const id = trimmed.slice(4).trim()
    return id ? { kind: 'llm', id } : null
  }
  if (trimmed.startsWith('agent:')) {
    const id = trimmed.slice(6).trim()
    return id ? { kind: 'cli', id } : null
  }
  return null
}

export function getModelPriceOverrides(): Record<string, TokenPrice> {
  return { ...(readAccounts().modelPriceOverrides ?? {}) }
}

export function setModelPriceOverride(key: string, price: TokenPrice | null): void {
  const parsed = parsePriceKey(key)
  if (!parsed) throw new Error('invalid price key')
  if (price) {
    if (!Number.isFinite(price.costPer1kIn) || price.costPer1kIn < 0) {
      throw new Error('costPer1kIn must be a finite number ≥ 0')
    }
    if (!Number.isFinite(price.costPer1kOut) || price.costPer1kOut < 0) {
      throw new Error('costPer1kOut must be a finite number ≥ 0')
    }
  }
  mutateAccounts((data) => {
    const next = { ...(data.modelPriceOverrides ?? {}) }
    if (!price) delete next[key]
    else next[key] = { costPer1kIn: price.costPer1kIn, costPer1kOut: price.costPer1kOut }
    data.modelPriceOverrides = next
  })
}

export function applyModelPriceOverrides(patch: Record<string, TokenPrice | null>): void {
  mutateAccounts((data) => {
    const next = { ...(data.modelPriceOverrides ?? {}) }
    for (const [key, price] of Object.entries(patch)) {
      if (!parsePriceKey(key)) continue
      if (!price) {
        delete next[key]
        continue
      }
      if (!Number.isFinite(price.costPer1kIn) || price.costPer1kIn < 0) continue
      if (!Number.isFinite(price.costPer1kOut) || price.costPer1kOut < 0) continue
      next[key] = { costPer1kIn: price.costPer1kIn, costPer1kOut: price.costPer1kOut }
    }
    data.modelPriceOverrides = next
  })
}

function presetFor(kind: PriceKind, id: string): TokenPrice | null {
  if (kind === 'llm') return LLM_PRICE_PRESETS[id] ?? null
  return CLI_AGENT_PRICE_PRESETS[id] ?? null
}

export function resolveTokenPrice(input: {
  model?: string
  agent?: string
}): { price: TokenPrice; source: PriceSource; key: string } | null {
  const overrides = getModelPriceOverrides()
  const model = input.model?.trim()
  if (model) {
    const key = llmPriceKey(model)
    if (overrides[key]) return { price: overrides[key], source: 'override', key }
    const preset = LLM_PRICE_PRESETS[model]
    if (preset) return { price: preset, source: 'preset', key }
  }
  const agent = input.agent?.trim()
  if (agent) {
    const key = agentPriceKey(agent)
    if (overrides[key]) return { price: overrides[key], source: 'override', key }
    const preset = CLI_AGENT_PRICE_PRESETS[agent]
    if (preset) return { price: preset, source: 'preset', key }
    return { price: CLI_AGENT_FALLBACK_PRICE, source: 'fallback', key }
  }
  return null
}

export function listModelPriceRows(extraLlmIds: string[] = []): ModelPriceRow[] {
  const overrides = getModelPriceOverrides()
  const llmIds = new Set([
    ...Object.keys(LLM_PRICE_PRESETS),
    ...extraLlmIds.map((id) => id.trim()).filter(Boolean),
  ])
  const agentIds = new Set([
    ...Object.keys(CLI_AGENT_PRICE_PRESETS),
  ])
  for (const key of Object.keys(overrides)) {
    const parsed = parsePriceKey(key)
    if (!parsed) continue
    if (parsed.kind === 'llm') llmIds.add(parsed.id)
    else agentIds.add(parsed.id)
  }

  const rows: ModelPriceRow[] = []
  for (const id of [...llmIds].sort()) {
    rows.push(rowFor('llm', id, overrides))
  }
  for (const id of [...agentIds].sort()) {
    rows.push(rowFor('cli', id, overrides))
  }
  return rows
}

function rowFor(
  kind: PriceKind,
  id: string,
  overrides: Record<string, TokenPrice>,
): ModelPriceRow {
  const key = kind === 'llm' ? llmPriceKey(id) : agentPriceKey(id)
  const preset = presetFor(kind, id)
  const override = overrides[key]
  if (override) {
    return { key, kind, id, preset, current: override, source: 'override' }
  }
  if (preset) {
    return { key, kind, id, preset, current: preset, source: 'preset' }
  }
  if (kind === 'cli') {
    return { key, kind, id, preset: null, current: CLI_AGENT_FALLBACK_PRICE, source: 'fallback' }
  }
  return { key, kind, id, preset: null, current: { costPer1kIn: 0, costPer1kOut: 0 }, source: 'unset' }
}
