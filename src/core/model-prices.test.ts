import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetAccountsCache } from './accounts-store.js'
import { estimateChargeUsd } from './points.js'
import { LLM_PRESETS, presetModels } from './llm/presets.js'
import {
  applyModelPriceOverrides,
  listModelPriceRows,
  llmPriceKey,
  agentPriceKey,
  resolveTokenPrice,
} from './model-prices.js'
import { CLI_AGENT_PRICE_PRESETS, LLM_PRICE_PRESETS } from './model-price-presets.js'

const saved: Record<string, string | undefined> = {}
let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agim-prices-'))
  saved.AGIM_HOME = process.env.AGIM_HOME
  process.env.AGIM_HOME = tmp
  _resetAccountsCache()
})

afterEach(() => {
  _resetAccountsCache()
  if (saved.AGIM_HOME === undefined) delete process.env.AGIM_HOME
  else process.env.AGIM_HOME = saved.AGIM_HOME
  rmSync(tmp, { recursive: true, force: true })
})

const CLI_ADAPTERS = [
  'claude-code',
  'cursor',
  'codex',
  'copilot',
  'opencode',
  'kimi-code',
  'qoder',
  'pi',
  'mimo',
  'antigravity',
] as const

describe('model prices', () => {
  it('presets every first-party LLM vendor model', () => {
    for (const preset of LLM_PRESETS) {
      if (preset.key === 'custom') continue
      for (const id of presetModels(preset)) {
        expect(LLM_PRICE_PRESETS[id]).toBeTruthy()
      }
    }
  })

  it('presets every CLI adapter name', () => {
    for (const name of CLI_ADAPTERS) {
      expect(CLI_AGENT_PRICE_PRESETS[name]).toBeTruthy()
    }
  })

  it('presets deepseek vision-exp at the flash off-peak rate', () => {
    const vision = LLM_PRICE_PRESETS['deepseek-v4-flash-vision-exp']
    const flash = LLM_PRICE_PRESETS['deepseek-v4-flash']
    expect(vision).toEqual(flash)
    expect(vision?.costPer1kIn).toBeCloseTo(0.00022)
    expect(vision?.costPer1kOut).toBeCloseTo(0.00066)
  })

  it('prices a vision-exp turn so Agim Agent is not blocked', () => {
    const priced = estimateChargeUsd({
      userId: 'usr_x',
      tokensIn: 1000,
      tokensOut: 1000,
      model: 'deepseek-v4-flash-vision-exp',
    })
    expect(priced?.source).toBe('preset')
    expect(priced?.usd).toBeCloseTo(0.00088)
  })

  it('prices CLI agents by adapter name', () => {
    const priced = estimateChargeUsd({
      userId: 'usr_x',
      tokensIn: 1000,
      tokensOut: 1000,
      agent: 'cursor',
    })
    expect(priced?.source).toBe('preset')
    expect(priced?.usd).toBeCloseTo(0.018)
  })

  it('falls back for an unknown CLI adapter instead of blocking spawn', () => {
    const priced = estimateChargeUsd({
      userId: 'usr_x',
      tokensIn: 1000,
      tokensOut: 1000,
      agent: 'brand-new-cli',
    })
    expect(priced?.source).toBe('preset')
    expect(priced?.usd).toBeCloseTo(0.01)
    expect(resolveTokenPrice({ agent: 'brand-new-cli' })?.source).toBe('fallback')
  })

  it('lets an admin override beat the preset', () => {
    applyModelPriceOverrides({
      [llmPriceKey('deepseek-v4-flash-vision-exp')]: { costPer1kIn: 0.001, costPer1kOut: 0.002 },
    })
    const resolved = resolveTokenPrice({ model: 'deepseek-v4-flash-vision-exp' })
    expect(resolved?.source).toBe('override')
    const priced = estimateChargeUsd({
      userId: 'usr_x',
      tokensIn: 1000,
      tokensOut: 1000,
      model: 'deepseek-v4-flash-vision-exp',
    })
    expect(priced?.usd).toBeCloseTo(0.003)
    applyModelPriceOverrides({ [llmPriceKey('deepseek-v4-flash-vision-exp')]: null })
    expect(resolveTokenPrice({ model: 'deepseek-v4-flash-vision-exp' })?.source).toBe('preset')
  })

  it('lets an admin override a CLI family rate', () => {
    applyModelPriceOverrides({
      [agentPriceKey('claude-code')]: { costPer1kIn: 0.01, costPer1kOut: 0.02 },
    })
    const priced = estimateChargeUsd({
      userId: 'usr_x',
      tokensIn: 1000,
      tokensOut: 1000,
      agent: 'claude-code',
    })
    expect(priced?.source).toBe('override')
    expect(priced?.usd).toBeCloseTo(0.03)
  })

  it('lists both LLM presets and CLI agents', () => {
    const rows = listModelPriceRows(['custom-sku'])
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('deepseek-v4-flash-vision-exp')
    expect(ids).toContain('claude-code')
    expect(ids).toContain('cursor')
    expect(ids).toContain('custom-sku')
    expect(rows.find((r) => r.id === 'custom-sku')?.source).toBe('unset')
  })

  it('leaves an unknown LLM unpriced so the admin panel can add it', () => {
    expect(resolveTokenPrice({ model: 'my-private-sku' })).toBeNull()
    expect(estimateChargeUsd({
      userId: 'usr_x',
      tokensIn: 1000,
      tokensOut: 1000,
      model: 'my-private-sku',
    })).toBeNull()
  })
})
