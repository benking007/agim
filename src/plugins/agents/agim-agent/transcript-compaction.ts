// Shared transcript compaction runner for Agim Agent (pre-turn + mid-turn).
//
// pi's AgentHarness.compact() requires phase === "idle", so during prompt()
// we must call prepareCompaction → compact → session.appendCompaction directly.
// Mid-turn runs from the turn_end subscriber (after tools land, before the
// next prepareNextTurn rebuilds context).

import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  getLastAssistantUsage,
  prepareCompaction,
  type CompactionSettings,
} from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import { estimateCostUsd } from '../../../core/llm/model-catalog.js'
import {
  applyClearingToPreparation,
  applyContextBudgetToMessages,
  COMPACTION_ACTIVITY_LABEL,
  effectiveCompactLine,
  estimateMessagesTokens,
  projectNextHopTokens,
  type ContextBudgetSettings,
  type ToolClearingSettings,
} from './context-budget.js'

export type CompactionActivityEmitter = (step: {
  id: string
  kind: 'status'
  label: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  preview?: string
}) => void

export interface TranscriptCompactionSession {
  getBranch(): Promise<unknown[]>
  buildContext(): Promise<{ messages: import('@earendil-works/pi-agent-core').AgentMessage[] }>
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details: unknown,
    fromHook: boolean,
  ): Promise<string>
}

export interface RunTranscriptCompactionArgs {
  session: TranscriptCompactionSession
  model: Model<string>
  getApiKeyAndHeaders: () => Promise<{ apiKey: string; headers?: Record<string, string> }>
  budget: ContextBudgetSettings
  /** Used for costKnown accounting. */
  costKnown: boolean
  thinkingLevel: Parameters<typeof compact>[6]
  signal: AbortSignal
  customInstructions: string | undefined
  emitActivity: CompactionActivityEmitter
  /** Log label: 'pre-turn' | 'mid-turn'. */
  reason: 'pre-turn' | 'mid-turn'
}

export interface RunTranscriptCompactionResult {
  compacted: boolean
  tokensBefore?: number
  approxIn: number
  approxOut: number
  estimatedCostUsd?: number
}

/** Whether context is over the effective L2 line (late and/or absolute). */
export function contextExceedsReserve(
  contextTokens: number,
  contextWindow: number,
  compaction: CompactionSettings,
  compactAtTokens = 0,
): boolean {
  if (!compaction.enabled) return false
  const line = effectiveCompactLine(contextWindow, compaction.reserveTokens, compactAtTokens)
  return line <= 0 ? contextTokens > 0 : contextTokens > line
}

/**
 * Mid-turn gate (with foresight): after tools land, project the next hop
 * (`current + lookahead`). If emergency clearing still cannot bring the
 * *projected* total under the effective L2 line, run transcript compact
 * before the next model call.
 */
export function shouldRunMidTurnCompaction(
  messages: import('@earendil-works/pi-agent-core').AgentMessage[],
  budget: ContextBudgetSettings,
  contextWindow: number,
): boolean {
  if (!budget.compaction.enabled || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return false
  }
  const line = effectiveCompactLine(
    contextWindow,
    budget.compaction.reserveTokens,
    budget.compactAtTokens,
  )
  const overLine = (tokens: number): boolean => (
    line <= 0 ? tokens > 0 : projectNextHopTokens(tokens, budget.lookaheadTokens) > line
  )

  if (!budget.clearing.enabled) {
    return overLine(estimateMessagesTokens(messages))
  }
  const { messages: afterClear, emergency } = applyContextBudgetToMessages(
    messages,
    budget,
    contextWindow,
  )
  // Only compact when foresight already raised the emergency soft line
  // (or we're past the effective line). Avoid summarizing on every quiet turn.
  if (!emergency) return false
  return overLine(estimateMessagesTokens(afterClear))
}

export async function measureContextTokens(
  session: TranscriptCompactionSession,
): Promise<number> {
  const branchEntries = await session.getBranch()
  const usage = getLastAssistantUsage(branchEntries as Parameters<typeof getLastAssistantUsage>[0])
  const estimated = estimateContextTokens((await session.buildContext()).messages).tokens
  return usage ? Math.max(calculateContextTokens(usage), estimated) : estimated
}

/**
 * Run one compaction cycle. Best-effort: throws on failure so the caller can
 * log and continue the turn. Emits Compacting context activity steps.
 */
export async function runTranscriptCompaction(
  args: RunTranscriptCompactionArgs,
): Promise<RunTranscriptCompactionResult> {
  const {
    session,
    model,
    getApiKeyAndHeaders,
    budget,
    costKnown,
    thinkingLevel,
    signal,
    customInstructions,
    emitActivity,
    reason,
  } = args

  const branchEntries = await session.getBranch()
  const preparationResult = prepareCompaction(
    branchEntries as Parameters<typeof prepareCompaction>[0],
    budget.compaction,
  )
  if (!preparationResult.ok) throw preparationResult.error
  const preparation = preparationResult.value
  if (!preparation) {
    return { compacted: false, approxIn: 0, approxOut: 0 }
  }

  const compactionId = `compaction-${reason}-${Date.now().toString(36)}`
  const compactionStartedAt = Date.now()
  emitActivity({
    id: compactionId,
    kind: 'status',
    label: COMPACTION_ACTIVITY_LABEL,
    status: 'running',
    startedAt: compactionStartedAt,
  })
  // Yield so the SPA can paint before a fast summarization round-trip.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 40)
  })

  try {
    const clearing: ToolClearingSettings = budget.clearing
    const clearedPrep = clearing.enabled
      ? applyClearingToPreparation(preparation, clearing)
      : preparation
    const auth = await getApiKeyAndHeaders()
    const compactResult = await compact(
      clearedPrep,
      model,
      auth.apiKey,
      auth.headers,
      customInstructions,
      signal,
      thinkingLevel,
    )
    if (!compactResult.ok) throw compactResult.error
    const compacted = compactResult.value
    await session.appendCompaction(
      compacted.summary,
      compacted.firstKeptEntryId,
      compacted.tokensBefore,
      compacted.details,
      true,
    )

    const approxOut = Math.max(1, Math.ceil(compacted.summary.length / 4))
    const approxIn = Math.max(approxOut, Math.min(compacted.tokensBefore, model.contextWindow))
    let estimatedCostUsd: number | undefined
    if (costKnown) {
      const estimatedCost = estimateCostUsd(undefined, model.id, {
        input: approxIn,
        output: approxOut,
      })
      if (estimatedCost != null) estimatedCostUsd = estimatedCost
    }

    emitActivity({
      id: compactionId,
      kind: 'status',
      label: COMPACTION_ACTIVITY_LABEL,
      status: 'success',
      startedAt: compactionStartedAt,
      finishedAt: Date.now(),
      preview: `${reason}: tokensBefore≈${compacted.tokensBefore}`,
    })
    console.info(
      `[agim-agent] compaction (${reason}): tokensBefore≈${compacted.tokensBefore} `
      + `→ kept from ${compacted.firstKeptEntryId.slice(0, 8)}… `
      + `(reserve=${budget.compaction.reserveTokens}, keepRecent=${budget.compaction.keepRecentTokens})`,
    )
    return {
      compacted: true,
      tokensBefore: compacted.tokensBefore,
      approxIn,
      approxOut,
      estimatedCostUsd,
    }
  } catch (err) {
    emitActivity({
      id: compactionId,
      kind: 'status',
      label: COMPACTION_ACTIVITY_LABEL,
      status: 'error',
      startedAt: compactionStartedAt,
      finishedAt: Date.now(),
      preview: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
