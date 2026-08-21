// Context-budget helpers for Agim Agent (P0).
//
// Maps the Anthropic cookbook triad onto the pi AgentHarness path:
//   - Tool-result clearing: surgically shrink old `toolResult` payloads in the
//     *messages view* sent to the model (and in compaction preparation).
//     Durable JSONL is left intact — re-open / UI history stay complete.
//   - Compaction knobs: env-tunable reserve / keepRecent.
//
// Default preset = late compaction with an absolute safety net:
//   L1 clear ~100–150k, L2 at min(window−reserve, 200k) so ~1M windows
//   still compact around 200k (set AGIM_CTX_COMPACT_AT_TOKENS=0 for pure late).

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
/**
 * Absolute L2 compact line (tokens). On ~1M windows, late compaction alone
 * waits until ~952k — long sessions (~200–300k body) never fire. Default
 * 200k so those sessions compact earlier; `AGIM_CTX_COMPACT_AT_TOKENS=0`
 * restores pure late-only. Effective line = min(window−reserve, this).
 */
export const DEFAULT_COMPACT_AT_TOKENS = 200_000
/**
 * Lookahead pad: assume one more hop may grow context by this many tokens
 * (assistant prose + follow-up tools). Mid-turn clear/compact fire earlier by
 * this amount. 0 disables foresight (hard line only).
 */
export const DEFAULT_LOOKAHEAD_TOKENS = 24_000

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
  /**
   * Absolute token ceiling for L2 compact (0 = disabled / late-only).
   * Combined with window−reserve via {@link effectiveCompactLine}.
   */
  compactAtTokens: number
  /**
   * Extra tokens assumed for the *next* model hop when deciding mid-turn
   * emergency clear / compact. Softens the late-compaction line without
   * changing pre-turn shouldCompact.
   */
  lookaheadTokens: number
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

/**
 * Absolute L2 line from env. Empty → default 200k. Explicit 0 / off / false
 * disables the absolute ceiling (pure window−reserve late compaction).
 */
export function resolveCompactAtTokens(): number {
  const raw = (process.env.AGIM_CTX_COMPACT_AT_TOKENS || '').trim().toLowerCase()
  if (!raw) return DEFAULT_COMPACT_AT_TOKENS
  if (raw === 'off' || raw === 'false' || raw === 'no') return 0
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_COMPACT_AT_TOKENS
  if (n <= 0) return 0
  return Math.min(2_000_000, Math.max(10_000, n))
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

/**
 * Session-scoped compression-rate preset (压缩率).
 * Global default is always `auto` (window-scaled env defaults).
 *   - full (满压): wait until near full window before L2 compact
 *   - balanced (均衡): mid reserve
 *   - frequent (频繁): compact earlier / more often
 */
export type CompactRate = 'auto' | 'full' | 'balanced' | 'frequent'

export const COMPACT_RATE_IDS: readonly CompactRate[] = [
  'auto', 'full', 'balanced', 'frequent',
] as const

/** Reserve as a share of the model window (before clamp). Keep SPA mirror in sync. */
export const COMPACT_RATE_RESERVE_SHARE: Record<Exclude<CompactRate, 'auto'>, number> = {
  full: 0.048,
  balanced: 0.12,
  frequent: 0.22,
}

export const COMPACT_RATE_KEEP_SHARE: Record<Exclude<CompactRate, 'auto'>, number> = {
  full: 0.032,
  balanced: 0.06,
  frequent: 0.05,
}

/** Extra headroom when judging whether a rate is safe vs current used tokens. */
export const COMPACT_RATE_USED_SAFETY = 1.1

export function normalizeCompactRate(raw: string | undefined | null): CompactRate {
  const s = (raw || '').trim().toLowerCase()
  if (!s || s === 'auto' || s === '自动') return 'auto'
  if (s === 'full' || s === 'late' || s === '满压') return 'full'
  if (s === 'balanced' || s === 'balance' || s === '均衡') return 'balanced'
  if (s === 'frequent' || s === '频繁') return 'frequent'
  return 'auto'
}

export function reserveTokensForCompactRate(
  contextWindow: number,
  rate: CompactRate,
  autoReserve: number,
): number {
  if (rate === 'auto') return autoReserve
  const window = Math.max(1, contextWindow)
  const target = Math.floor(window * COMPACT_RATE_RESERVE_SHARE[rate])
  return clampToWindowShare(Math.max(4_096, target), window, 0.25, 4_096)
}

export function keepRecentTokensForCompactRate(
  contextWindow: number,
  rate: CompactRate,
  autoKeep: number,
): number {
  if (rate === 'auto') return autoKeep
  const window = Math.max(1, contextWindow)
  const target = Math.floor(window * COMPACT_RATE_KEEP_SHARE[rate])
  return clampToWindowShare(Math.max(4_096, target), window, 0.20, 4_096)
}

/** Hard line for a compact-rate choice (uses auto reserve when rate=auto). */
export function hardLineForCompactRate(
  contextWindow: number,
  rate: CompactRate,
  autoReserve: number,
): number {
  return hardBudgetLine(
    contextWindow,
    reserveTokensForCompactRate(contextWindow, rate, autoReserve),
  )
}

/**
 * True when choosing `rate` would keep the hard line at/above current used
 * (with safety margin). Approximate SPA estimates should pass used*margin.
 */
export function isCompactRateSafe(
  contextWindow: number,
  usedTokens: number,
  rate: CompactRate,
  autoReserve: number,
  safety = COMPACT_RATE_USED_SAFETY,
): boolean {
  const used = Math.max(0, usedTokens) * Math.max(1, safety)
  return hardLineForCompactRate(contextWindow, rate, autoReserve) >= used
}

/** Resolve budget knobs from env (+ optional session compact-rate overlay). */
export function resolveContextBudgetSettings(
  contextWindow?: number,
  compactRate?: CompactRate | string | null,
): ContextBudgetSettings {
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

  let reserveTokens = envInt(
    'AGIM_CTX_COMPACT_RESERVE_TOKENS',
    defaultReserve,
    4_096,
    256_000,
  )
  let keepRecentTokens = envInt(
    'AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS',
    defaultKeep,
    4_096,
    200_000,
  )

  // Session overlay: non-auto rates replace reserve/keep (env still wins for auto).
  const rate = normalizeCompactRate(compactRate)
  if (rate !== 'auto') {
    reserveTokens = reserveTokensForCompactRate(window, rate, reserveTokens)
    keepRecentTokens = keepRecentTokensForCompactRate(window, rate, keepRecentTokens)
  }

  // Default lookahead ≈ half reserve (capped); AGIM_CTX_LOOKAHEAD_TOKENS=0 disables.
  const defaultLookahead = Math.min(
    DEFAULT_LOOKAHEAD_TOKENS,
    Math.max(0, Math.floor(reserveTokens * 0.5)),
  )
  const lookaheadTokens = envInt('AGIM_CTX_LOOKAHEAD_TOKENS', defaultLookahead, 0, 256_000)

  const instructionsRaw = (process.env.AGIM_CTX_COMPACT_INSTRUCTIONS || '').trim()
  const compactInstructions = instructionsRaw || DEFAULT_AGIM_COMPACT_INSTRUCTIONS
  const compactAtTokens = resolveCompactAtTokens()

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
    compactAtTokens,
    lookaheadTokens,
    compactInstructions,
  }
}

/** Hard late-compaction line: window − reserve. */
export function hardBudgetLine(contextWindow: number, reserveTokens: number): number {
  return contextWindow - reserveTokens
}

/**
 * Effective L2 trigger line: earlier of (window−reserve) and absolute
 * `compactAtTokens` when the absolute ceiling is enabled (>0).
 */
export function effectiveCompactLine(
  contextWindow: number,
  reserveTokens: number,
  compactAtTokens: number,
): number {
  const hard = hardBudgetLine(contextWindow, reserveTokens)
  if (!(compactAtTokens > 0)) return hard
  return Math.min(hard, compactAtTokens)
}

/**
 * Soft line used for mid-turn foresight: effective compact line minus
 * lookahead pad. When lookahead is 0, soft === effective.
 */
export function softBudgetLine(
  contextWindow: number,
  reserveTokens: number,
  lookaheadTokens: number,
  compactAtTokens = 0,
): number {
  return effectiveCompactLine(contextWindow, reserveTokens, compactAtTokens)
    - Math.max(0, lookaheadTokens)
}

/** Projected tokens for the next hop = current estimate + lookahead pad. */
export function projectNextHopTokens(currentTokens: number, lookaheadTokens: number): number {
  return currentTokens + Math.max(0, lookaheadTokens)
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
  // Soft line (lookahead): clear urgently before the effective L2 line
  // (min(window−reserve, compactAtTokens)) so the *next* hop still has room.
  const emergencyLine = softBudgetLine(
    window,
    budget.compaction.reserveTokens,
    budget.lookaheadTokens,
    budget.compactAtTokens,
  )
  // When the soft/hard line is non-positive (tiny / misconfigured window),
  // treat any non-empty context as already past budget.
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
