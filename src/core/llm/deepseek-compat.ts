// DeepSeek V4 wire-format helpers shared by OpenAICompat + Agim Agent (pi).
// Official docs: https://api-docs.deepseek.com/

import { createHash } from 'node:crypto'

/**
 * Build a DeepSeek `user_id` for content-safety / KV-cache / scheduling
 * isolation. Must match `[a-zA-Z0-9\-_]+` (max 512) and must NOT contain PII —
 * we hash `platform:userId` and prefix with `agim-`.
 */
export function hashDeepSeekUserId(
  platform: string | undefined | null,
  userId: string | undefined | null,
): string | undefined {
  const p = (platform ?? '').trim()
  const u = (userId ?? '').trim()
  if (!p && !u) return undefined
  const hex = createHash('sha256').update(`${p}:${u}`).digest('hex').slice(0, 32)
  return `agim-${hex}`
}

/**
 * DeepSeek OpenAI-compat thinking effort map (pi ThinkingLevel → API
 * `reasoning_effort`). Official efforts: low / high / max (plus xhigh→max).
 * `minimal` / `off` disable thinking; `medium` (Agim UI mid chip) → high.
 */
export const DEEPSEEK_THINKING_LEVEL_MAP = {
  minimal: null,
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
} as const

/** Inject `user_id` into an OpenAI Chat Completions request body when absent. */
export function withDeepSeekUserId(
  payload: Record<string, unknown>,
  userId: string | undefined,
): Record<string, unknown> {
  if (!userId) return payload
  if (payload.user_id != null && String(payload.user_id).length > 0) return payload
  return { ...payload, user_id: userId }
}
