/**
 * Session-scoped compression-rate helpers for the Usage popover.
 * Keep share tables in sync with `src/plugins/agents/agim-agent/context-budget.ts`.
 */

export type CompactRate = 'auto' | 'full' | 'balanced' | 'frequent'

export const COMPACT_RATE_OPTIONS: readonly {
  id: CompactRate
  /** i18n key suffix under chat.statusBar.compactRate.* */
  labelKey: string
}[] = [
  { id: 'auto', labelKey: 'auto' },
  { id: 'full', labelKey: 'full' },
  { id: 'balanced', labelKey: 'balanced' },
  { id: 'frequent', labelKey: 'frequent' },
] as const

const RESERVE_SHARE: Record<Exclude<CompactRate, 'auto'>, number> = {
  full: 0.048,
  balanced: 0.12,
  frequent: 0.22,
}

/** Approx auto reserve (mirrors late-compaction defaults + window clamp). */
export function estimateAutoReserve(contextWindow: number): number {
  const window = Math.max(1, contextWindow)
  const target = 48_000
  const shareCap = Math.max(8_192, Math.floor(window * 0.25))
  return Math.min(target, shareCap)
}

export function reserveForCompactRate(contextWindow: number, rate: CompactRate): number {
  const window = Math.max(1, contextWindow)
  if (rate === 'auto') return estimateAutoReserve(window)
  const target = Math.floor(window * RESERVE_SHARE[rate])
  const shareCap = Math.max(4_096, Math.floor(window * 0.25))
  return Math.min(Math.max(4_096, target), shareCap)
}

export function hardLineForCompactRate(contextWindow: number, rate: CompactRate): number {
  return Math.max(0, contextWindow - reserveForCompactRate(contextWindow, rate))
}

/** Hide/disable rates whose hard line would sit below current used (+ margin). */
export function isCompactRateSafe(
  contextWindow: number,
  usedTokens: number,
  rate: CompactRate,
  safety = 1.1,
): boolean {
  const used = Math.max(0, usedTokens) * Math.max(1, safety)
  return hardLineForCompactRate(contextWindow, rate) >= used
}

export function normalizeCompactRate(raw: string | undefined | null): CompactRate {
  const s = (raw || '').trim().toLowerCase()
  if (s === 'full' || s === 'late' || s === '满压') return 'full'
  if (s === 'balanced' || s === 'balance' || s === '均衡') return 'balanced'
  if (s === 'frequent' || s === '频繁') return 'frequent'
  return 'auto'
}
