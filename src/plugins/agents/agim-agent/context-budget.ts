// Context-budget helpers for Agim Agent (P0).
//
// Maps the Anthropic cookbook triad onto the pi AgentHarness path:
//   - Tool-result clearing: surgically shrink old `toolResult` payloads in the
//     *messages view* sent to the model (and in compaction preparation).
//     Durable JSONL is left intact — re-open / UI history stay complete.
//   - Compaction knobs: env-tunable reserve / keepRecent.
//
// Default preset = late compaction (prefer raw context; pay for summary late):
//   L1 clear ~100–150k, L2 compact near full window (1M → ~952k with 48k reserve).

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  estimateTokens,
  type CompactionPreparation,
  type CompactionSettings,
} from '@earendil-works/pi-agent-core'

/** Late-compaction defaults for ~1M-class windows (clamped on smaller windows). */
export const DEFAULT_COMPACT_RESERVE_TOKENS = 48_000
export const DEFAULT_COMPACT_KEEP_RECENT_TOKENS = 32_000
export const DEFAULT_CLEAR_KEEP_TOOL_USES = 8
/** Soft ceiling for the auto clear-trigger (15% of window, bounded below). */
export const DEFAULT_CLEAR_TRIGGER_CAP = 150_000
export const DEFAULT_CLEAR_TRIGGER_FLOOR = 50_000

/** Placeholder prefix so we never double-clear the same result. */
export const CLEARED_TOOL_RESULT_PREFIX = '[cleared tool_result:'

/** Stable activity label for web chat "compacting" status steps (i18n maps this). */
export const COMPACTION_ACTIVITY_LABEL = 'Compacting context'

/** Default tools whose results must survive clearing (state / memory / UX). */
export const DEFAULT_CLEAR_EXCLUDE_TOOLS = [
  'memory',
  'memory_save',
  'memory_query',
  'save_memo',
  'search_memos',
  'update_memo',
  'delete_memo',
  'long_task',
  'complete_goal',
  'ask_user',
  'push_message',
] as const

export interface ToolClearingSettings {
  enabled: boolean
  /** Estimated context tokens above which clearing runs. */
  triggerTokens: number
  /** Keep this many most-recent toolResult messages intact. */
  keepToolUses: number
  /** Skip clearing when fewer than this many chars would be freed. */
  clearAtLeastChars: number
  /** Tool-name patterns (case-insensitive; matched as exact / suffix / __name). */
  excludeTools: string[]
}

export interface ContextBudgetSettings {
  clearing: ToolClearingSettings
  compaction: CompactionSettings
  /** Replaces pi's default summarization framing when non-empty. */
  compactInstructions: string | undefined
}

export interface ClearToolResultsResult {
  messages: AgentMessage[]
  clearedCount: number
  charsFreed: number
  applied: boolean
}

function envFlagOff(name: string): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase()
  return raw === 'off' || raw === '0' || raw === 'false' || raw === 'no'
}

/**
 * Compaction master switch. Prefer `AGIM_CTX_COMPACT`; legacy
 * `AGIM_NATIVE_COMPACTION=off` still disables.
 */
export function isContextCompactionEnabled(): boolean {
  return !envFlagOff('AGIM_CTX_COMPACT') && !envFlagOff('AGIM_NATIVE_COMPACTION')
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] || '').trim()
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function parseExcludeList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...DEFAULT_CLEAR_EXCLUDE_TOOLS]
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Clamp a target so small windows cannot reserve/keep more than a safe share. */
export function clampToWindowShare(
  target: number,
  window: number,
  maxShare: number,
  floor: number,
): number {
  const shareCap = Math.max(floor, Math.floor(window * maxShare))
  return Math.min(target, shareCap)
}

/** Resolve budget knobs from env. Safe to call every turn (no process cache). */
export function resolveContextBudgetSettings(contextWindow?: number): ContextBudgetSettings {
  const window = Number.isFinite(contextWindow) && (contextWindow as number) > 0
    ? (contextWindow as number)
    : 1_000_000
  // L1: early cheap relief. ~15% of window, floored at 50k, capped at 150k
  // (1M → 150k; 128k → 50k).
  const defaultClearTrigger = Math.min(
    DEFAULT_CLEAR_TRIGGER_CAP,
    Math.max(DEFAULT_CLEAR_TRIGGER_FLOOR, Math.floor(window * 0.15)),
  )

  // AGIM_CTX_CLEARING is a legacy alias of AGIM_CTX_CLEAR.
  const clearingEnabled = !envFlagOff('AGIM_CTX_CLEAR') && !envFlagOff('AGIM_CTX_CLEARING')
  const compactionEnabled = isContextCompactionEnabled()

  // L2 late compaction: 48k reserve / 32k keep on 1M-class windows.
  // Clamp so tiny windows never set reserve ≥ contextWindow (always-compact).
  const defaultReserve = clampToWindowShare(DEFAULT_COMPACT_RESERVE_TOKENS, window, 0.25, 8_192)
  const defaultKeep = clampToWindowShare(DEFAULT_COMPACT_KEEP_RECENT_TOKENS, window, 0.20, 8_192)

  const reserveTokens = envInt(
    'AGIM_CTX_COMPACT_RESERVE_TOKENS',
    defaultReserve,
    4_096,
    256_000,
  )
  const keepRecentTokens = envInt(
    'AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS',
    defaultKeep,
    4_096,
    200_000,
  )

  const instructionsRaw = (process.env.AGIM_CTX_COMPACT_INSTRUCTIONS || '').trim()
  const compactInstructions = instructionsRaw || DEFAULT_AGIM_COMPACT_INSTRUCTIONS

  return {
    clearing: {
      enabled: clearingEnabled,
      triggerTokens: envInt('AGIM_CTX_CLEAR_TRIGGER_TOKENS', defaultClearTrigger, 10_000, 2_000_000),
      keepToolUses: envInt('AGIM_CTX_CLEAR_KEEP_TOOL_USES', DEFAULT_CLEAR_KEEP_TOOL_USES, 0, 100),
      clearAtLeastChars: envInt('AGIM_CTX_CLEAR_AT_LEAST_CHARS', 8_000, 0, 10_000_000),
      excludeTools: parseExcludeList(process.env.AGIM_CTX_CLEAR_EXCLUDE),
    },
    compaction: {
      enabled: compactionEnabled,
      reserveTokens,
      keepRecentTokens,
    },
    compactInstructions,
  }
}

/** Agim-tuned compaction brief (cookbook: custom instructions fully replace the default). */
export const DEFAULT_AGIM_COMPACT_INSTRUCTIONS = [
  'Summarize this Agim Agent transcript for continuity after context reset.',
  'Preserve, with concrete identifiers when present:',
  '- the user goal / active long_task and what remains unfinished',
  '- hard user constraints and decisions (do / do-not)',
  '- file paths, bgjob ids, log paths, memo ids, and key tool outcomes',
  '- failed approaches so the agent does not repeat them',
  '- the immediate next step',
  'Omit raw tool payloads, repeated file dumps, and chit-chat.',
  'Write the summary in the same language the user primarily used.',
].join(' ')

export function isExcludedToolName(toolName: string, excludeTools: readonly string[]): boolean {
  const n = toolName.toLowerCase()
  for (const raw of excludeTools) {
    const needle = raw.toLowerCase().trim()
    if (!needle) continue
    if (n === needle) return true
    if (n.endsWith(`_${needle}`) || n.endsWith(`__${needle}`)) return true
    if (n.includes(`__${needle}`) || n.includes(`_${needle}_`)) return true
    // bare "memory" should match memory / memory_save / mcp__agim__memory_query
    if (needle === 'memory' && (n === 'memory' || n.includes('memory_'))) return true
  }
  return false
}

function toolResultText(msg: Extract<AgentMessage, { role: 'toolResult' }>): string {
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function alreadyCleared(msg: Extract<AgentMessage, { role: 'toolResult' }>): boolean {
  return toolResultText(msg).startsWith(CLEARED_TOOL_RESULT_PREFIX)
}

type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>

function clearedPlaceholder(toolName: string, originalChars: number): ToolResultMessage['content'] {
  return [{
    type: 'text',
    text: `${CLEARED_TOOL_RESULT_PREFIX} ${toolName}; originalChars=${originalChars}; re-call the tool to refetch]`,
  }]
}

/** Estimate tokens for a message list (pi heuristic). */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateTokens(m)
  return total
}

/**
 * Clear old toolResult payloads, keeping the most recent `keepToolUses`.
 * Returns the original array reference when nothing changes.
 */
export function clearToolResultsInMessages(
  messages: AgentMessage[],
  settings: ToolClearingSettings,
): ClearToolResultsResult {
  if (!settings.enabled || messages.length === 0) {
    return { messages, clearedCount: 0, charsFreed: 0, applied: false }
  }

  const estimated = estimateMessagesTokens(messages)
  if (estimated <= settings.triggerTokens) {
    return { messages, clearedCount: 0, charsFreed: 0, applied: false }
  }

  const toolIndexes: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'toolResult') toolIndexes.push(i)
  }
  if (toolIndexes.length === 0) {
    return { messages, clearedCount: 0, charsFreed: 0, applied: false }
  }

  const keep = Math.max(0, settings.keepToolUses)
  const keepSet = new Set(toolIndexes.slice(Math.max(0, toolIndexes.length - keep)))

  let clearedCount = 0
  let charsFreed = 0
  let next: AgentMessage[] | null = null

  for (const idx of toolIndexes) {
    if (keepSet.has(idx)) continue
    const msg = messages[idx]
    if (msg?.role !== 'toolResult') continue
    if (isExcludedToolName(msg.toolName, settings.excludeTools)) continue
    if (alreadyCleared(msg)) continue

    const original = toolResultText(msg)
    // Skip tiny results — not worth a placeholder.
    if (original.length < 200) continue

    charsFreed += original.length
    clearedCount++
    if (!next) next = messages.slice()
    next[idx] = {
      ...msg,
      content: clearedPlaceholder(msg.toolName, original.length),
      // Drop bulky details blobs (often mirror the text payload).
      details: undefined,
    }
  }

  if (!next || clearedCount === 0) {
    return { messages, clearedCount: 0, charsFreed: 0, applied: false }
  }
  if (charsFreed < settings.clearAtLeastChars) {
    return { messages, clearedCount: 0, charsFreed: 0, applied: false }
  }
  return { messages: next, clearedCount, charsFreed, applied: true }
}

/** Apply clearing to compaction preparation message lists (summarizer input). */
export function applyClearingToPreparation(
  preparation: CompactionPreparation,
  settings: ToolClearingSettings,
): CompactionPreparation {
  if (!settings.enabled) return preparation
  // For summarizer input, always clear aggressively: keep=0 on the lists being
  // summarized (they are about to be dropped from the live window anyway).
  const aggressive: ToolClearingSettings = {
    ...settings,
    triggerTokens: 0,
    keepToolUses: 0,
    clearAtLeastChars: 0,
  }
  const a = clearToolResultsInMessages(preparation.messagesToSummarize, aggressive)
  const b = clearToolResultsInMessages(preparation.turnPrefixMessages, aggressive)
  if (!a.applied && !b.applied) return preparation
  return {
    ...preparation,
    messagesToSummarize: a.messages,
    turnPrefixMessages: b.messages,
  }
}

/**
 * Mid-turn budget guard (late-compaction companion).
 *
 * Pre-turn L2 compact only runs once per user message. If tools inflate the
 * window during the turn past `contextWindow - reserveTokens`, we cannot
 * always afford a second summarization round-trip — but we *can* urgently
 * strip re-fetchable tool payloads so the next model call still fits.
 *
 * Returns `{ messages, emergency }` where `emergency` is true when the
 * aggressive path ran. No UI — logs only (operator preference).
 */
export function applyContextBudgetToMessages(
  messages: AgentMessage[],
  budget: ContextBudgetSettings,
  contextWindow: number,
): { messages: AgentMessage[]; emergency: boolean; cleared: ClearToolResultsResult } {
  if (!budget.clearing.enabled || messages.length === 0) {
    return {
      messages,
      emergency: false,
      cleared: { messages, clearedCount: 0, charsFreed: 0, applied: false },
    }
  }

  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 1_000_000
  const estimated = estimateMessagesTokens(messages)
  const emergencyLine = window - budget.compaction.reserveTokens
  // When reserve ≥ window (tiny / misconfigured), treat any non-empty context
  // as already past the late-compaction line.
  const emergency = emergencyLine <= 0 ? estimated > 0 : estimated > emergencyLine

  const settings: ToolClearingSettings = emergency
    ? {
        ...budget.clearing,
        triggerTokens: 0,
        keepToolUses: Math.min(2, budget.clearing.keepToolUses),
        clearAtLeastChars: 0,
      }
    : budget.clearing

  const cleared = clearToolResultsInMessages(messages, settings)
  return { messages: cleared.messages, emergency, cleared }
}
