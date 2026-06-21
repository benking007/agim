// model-catalog — pi-ai MODELS wrapper. Picks a real catalogued model at
// runtime so the assertions don't hardcode ids that churn between pi versions.

import { getModels, getProviders } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'bun:test'
import { estimateCostUsd, findCatalogModel, lookupModelMeta } from '../../src/core/llm/model-catalog.js'

function sampleModel(): { provider: string; id: string } | null {
  for (const p of getProviders()) {
    let ms: Array<{ provider: string; id: string; contextWindow: number; cost?: { input?: number } }> = []
    try {
      ms = getModels(p as Parameters<typeof getModels>[0]) as typeof ms
    } catch {
      continue
    }
    const m = ms.find((x) => x.contextWindow > 0 && (x.cost?.input ?? 0) > 0)
    if (m) return { provider: m.provider, id: m.id }
  }
  return null
}

describe('model-catalog (pi-ai wrapper)', () => {
  it('resolves a real catalogued model by (provider, id)', () => {
    const m = sampleModel()
    expect(m).toBeTruthy()
    if (m) expect(findCatalogModel(m.provider, m.id)?.id).toBe(m.id)
  })

  it('resolves by exact id even when providerType is wrong (scan fallback)', () => {
    const m = sampleModel()
    if (m) expect(findCatalogModel('totally-unknown-provider', m.id)?.id).toBe(m.id)
  })

  it('lookupModelMeta returns a positive contextWindow', () => {
    const m = sampleModel()
    if (m) expect(lookupModelMeta(m.provider, m.id)?.contextWindow ?? 0).toBeGreaterThan(0)
  })

  it('estimateCostUsd computes a positive cost from token counts', () => {
    const m = sampleModel()
    if (m) {
      const cost = estimateCostUsd(m.provider, m.id, { input: 10_000, output: 10_000 })
      expect(cost).not.toBeNull()
      expect(cost ?? 0).toBeGreaterThan(0)
    }
  })

  it('returns null for an uncatalogued model', () => {
    expect(findCatalogModel('openai', 'no-such-model-xyz-000')).toBeNull()
    expect(lookupModelMeta(undefined, 'no-such-model-xyz-000')).toBeNull()
    expect(estimateCostUsd('openai', 'no-such-model-xyz-000', { input: 1, output: 1 })).toBeNull()
  })
})
