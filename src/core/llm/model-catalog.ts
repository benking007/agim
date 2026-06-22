// Model metadata catalog — a thin wrapper over @earendil-works/pi-ai's MODELS
// table. agim's own providers (anthropic / openai-compat) carry only a
// (providerType, model) string pair and often get no cost back from the
// upstream API, so their usage telemetry shows costUsd = undefined. This maps
// them onto pi-ai's catalog to:
//   - backfill real USD cost from token counts (calculateCost), and
//   - expose contextWindow / maxTokens for context-budget decisions.
// Agim Agent gets this directly from pi-ai; this brings the same to the
// legacy providers WITHOUT maintaining a second price table.

import { calculateCost, getModels, getProviders, type Model } from '@earendil-works/pi-ai'

// agim providerType → pi-ai KnownProvider, only where the spellings differ.
// Unknown keys fall through to a full-catalog scan by exact model id.
const PROVIDER_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  gemini: 'google',
  grok: 'xai',
  kimi: 'moonshot',
}

function modelsOf(provider: string): Array<Model<string>> {
  try {
    return getModels(provider as Parameters<typeof getModels>[0]) as Array<Model<string>>
  } catch {
    return []
  }
}

/** Resolve a pi-ai catalog Model for an agim (providerType, modelId) pair. */
export function findCatalogModel(providerType: string | undefined, modelId: string): Model<string> | null {
  if (!modelId) return null
  const hint = providerType?.toLowerCase()
  const aliased = hint ? (PROVIDER_ALIASES[hint] ?? hint) : undefined
  if (aliased) {
    const hit = modelsOf(aliased).find((m) => m.id === modelId)
    if (hit) return hit
  }
  // Fall back to scanning every known provider for the exact model id.
  for (const p of getProviders()) {
    const hit = modelsOf(p).find((m) => m.id === modelId)
    if (hit) return hit
  }
  return null
}

export interface ModelMeta {
  contextWindow: number
  maxTokens: number
}

/** contextWindow / maxTokens for an agim backend, or null when uncatalogued. */
export function lookupModelMeta(providerType: string | undefined, modelId: string): ModelMeta | null {
  const m = findCatalogModel(providerType, modelId)
  return m ? { contextWindow: m.contextWindow, maxTokens: m.maxTokens } : null
}

/** Estimate cost (USD) from token counts via the catalog, or null when the
 *  model isn't catalogued. cacheRead / cacheWrite default to 0. */
export function estimateCostUsd(
  providerType: string | undefined,
  modelId: string,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number | null {
  const model = findCatalogModel(providerType, modelId)
  if (!model) return null
  const cost = calculateCost(model, {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
    totalTokens: tokens.input + tokens.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  })
  return cost?.total ?? null
}
