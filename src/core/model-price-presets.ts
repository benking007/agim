/**
 * Built-in USD rates for Agim LLM SKUs and CLI agents.
 *
 * Stored as USD per 1k tokens (divide list prices that are quoted per 1M
 * by 1000). Admins can override in Settings → Pricing; these values are
 * the factory defaults, not a live scrape of vendor pages.
 *
 * DeepSeek V4 numbers match the official off-peak card
 * (https://api-docs.deepseek.com/quick_start/pricing). Vision-exp bills
 * at the same rate as flash. Other vendors and CLI agents use typical
 * published list prices for the family so a billable user is never
 * blocked with "no model price".
 */

export interface TokenPrice {
  costPer1kIn: number
  costPer1kOut: number
}

/** Convert a per-1M-token list price into the per-1k unit we store. */
export function usdPer1mToPer1k(usdPer1m: number): number {
  return usdPer1m / 1000
}

export function usdPer1kToPer1m(usdPer1k: number): number {
  return usdPer1k * 1000
}

function per1m(inputUsdPer1m: number, outputUsdPer1m: number): TokenPrice {
  return {
    costPer1kIn: usdPer1mToPer1k(inputUsdPer1m),
    costPer1kOut: usdPer1mToPer1k(outputUsdPer1m),
  }
}

/** Agim Agent / openai-compat model ids (exact match on `llmBackends.model`). */
export const LLM_PRICE_PRESETS: Record<string, TokenPrice> = {
  // DeepSeek official off-peak (cache miss / output).
  'deepseek-v4-pro': per1m(0.66, 1.98),
  'deepseek-v4-flash': per1m(0.22, 0.66),
  'deepseek-v4-flash-vision-exp': per1m(0.22, 0.66),
  // Moonshot / Kimi
  'kimi-k3': per1m(1.2, 6),
  'kimi-k2.6': per1m(0.6, 2.5),
  // Zhipu GLM
  'glm-5.2': per1m(1, 4),
  'glm-4.7-flash': per1m(0.1, 0.4),
  // Xiaomi MiMo
  'mimo-v2.5-pro': per1m(0.8, 2.4),
  'mimo-v2.5': per1m(0.2, 0.6),
}

/**
 * CLI adapters billed as a family (the subprocess does not always
 * expose a stable model id). One row per `AgentBase.name`.
 */
export const CLI_AGENT_PRICE_PRESETS: Record<string, TokenPrice> = {
  'claude-code': per1m(3, 15),
  cursor: per1m(3, 15),
  codex: per1m(2, 8),
  copilot: per1m(2, 8),
  opencode: per1m(3, 15),
  'kimi-code': per1m(0.6, 2.5),
  qoder: per1m(1, 3),
  pi: per1m(1, 3),
  mimo: per1m(0.8, 2.4),
  antigravity: per1m(0.15, 0.6),
}

/** Unknown CLI adapter — still billable so spawn is not blocked. */
export const CLI_AGENT_FALLBACK_PRICE: TokenPrice = per1m(2, 8)
