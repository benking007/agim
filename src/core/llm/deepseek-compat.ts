// DeepSeek V4 wire-format helpers shared by OpenAICompat + Agim Agent (pi).
// Official docs: https://api-docs.deepseek.com/

import { createHash } from 'node:crypto'

export const DEEPSEEK_OPENAI_BASE = 'https://api.deepseek.com'
export const DEEPSEEK_ANTHROPIC_BASE = 'https://api.deepseek.com/anthropic'
/** Beta base for strict tools, FIM, and chat prefix completion. */
export const DEEPSEEK_BETA_BASE = 'https://api.deepseek.com/beta'

export type DeepSeekApiDialect = 'openai' | 'anthropic'

/**
 * DeepSeek OpenAI-compat thinking effort map (pi ThinkingLevel → API
 * `reasoning_effort` / Anthropic `output_config.effort`).
 * Official efforts: low / high / max. `medium` (Agim UI) → high.
 */
export const DEEPSEEK_THINKING_LEVEL_MAP = {
  minimal: null,
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
} as const

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

export function isDeepSeekAnthropicBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    const u = new URL(baseUrl)
    return u.hostname.toLowerCase().includes('deepseek.com')
      && u.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/anthropic')
  } catch {
    return /deepseek\.com\/anthropic/i.test(baseUrl)
  }
}

/** Chat Completions base: beta when strict tools / prefix / FIM are active. */
export function resolveDeepSeekOpenAiBaseUrl(opts: {
  strictTools?: boolean
  beta?: boolean
}): string {
  return opts.strictTools || opts.beta ? DEEPSEEK_BETA_BASE : DEEPSEEK_OPENAI_BASE
}

/** Inject OpenAI-format top-level `user_id` when absent. */
export function withDeepSeekUserId(
  payload: Record<string, unknown>,
  userId: string | undefined,
): Record<string, unknown> {
  if (!userId) return payload
  if (payload.user_id != null && String(payload.user_id).length > 0) return payload
  return { ...payload, user_id: userId }
}

/** Inject Anthropic-format `metadata.user_id` when absent. */
export function withDeepSeekAnthropicUserId(
  payload: Record<string, unknown>,
  userId: string | undefined,
): Record<string, unknown> {
  if (!userId) return payload
  const meta = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
    ? { ...(payload.metadata as Record<string, unknown>) }
    : {}
  if (meta.user_id != null && String(meta.user_id).length > 0) {
    return payload
  }
  return { ...payload, metadata: { ...meta, user_id: userId } }
}

/**
 * Normalize a JSON Schema so DeepSeek `strict: true` (beta) accepts it:
 * - every object has `additionalProperties: false`
 * - every object property is listed in `required`
 * - strip unsupported keywords (min/max length/items, pattern, …)
 */
export function normalizeJsonSchemaForStrict(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
  return normalizeNode(schema as Record<string, unknown>)
}

const STRIP_KEYS = new Set([
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format', 'default',
  'examples', '$schema', '$id', 'title',
])

function normalizeNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (STRIP_KEYS.has(k)) continue
    out[k] = v
  }

  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map((branch) =>
      branch && typeof branch === 'object' && !Array.isArray(branch)
        ? normalizeNode(branch as Record<string, unknown>)
        : branch,
    )
  }

  const type = out.type
  const isObject = type === 'object'
    || (Array.isArray(type) && type.includes('object'))
    || (out.properties != null && typeof out.properties === 'object')

  if (isObject) {
    const propsIn = out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)
      ? out.properties as Record<string, unknown>
      : {}
    const propsOut: Record<string, unknown> = {}
    for (const [name, propSchema] of Object.entries(propsIn)) {
      propsOut[name] = propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)
        ? normalizeNode(propSchema as Record<string, unknown>)
        : propSchema
    }
    out.properties = propsOut
    out.additionalProperties = false
    out.required = Object.keys(propsOut)
    if (!out.type) out.type = 'object'
  }

  if (out.type === 'array' || (Array.isArray(out.type) && out.type.includes('array'))) {
    if (out.items && typeof out.items === 'object' && !Array.isArray(out.items)) {
      out.items = normalizeNode(out.items as Record<string, unknown>)
    }
  }

  return out
}

/** Rewrite OpenAI Chat Completions `tools[]` for DeepSeek strict mode. */
export function applyStrictToolsToOpenAiPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const tools = payload.tools
  if (!Array.isArray(tools) || tools.length === 0) return payload
  const nextTools = tools.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const tool = { ...(raw as Record<string, unknown>) }
    const fnIn = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function)
      ? { ...(tool.function as Record<string, unknown>) }
      : null
    if (!fnIn) return tool
    const params = normalizeJsonSchemaForStrict(fnIn.parameters)
    tool.function = { ...fnIn, strict: true, parameters: params }
    return tool
  })
  return { ...payload, tools: nextTools }
}

/**
 * DeepSeek Anthropic dialect: strip budget_tokens/display; keep
 * thinking.type enabled|disabled; attach output_config.effort when enabled.
 */
export function normalizeDeepSeekAnthropicThinkingPayload(
  payload: Record<string, unknown>,
  effort: string | undefined,
): Record<string, unknown> {
  const thinking = payload.thinking
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
    return payload
  }
  const t = thinking as Record<string, unknown>
  const enabled = t.type === 'enabled' || t.type === 'adaptive'
  if (!enabled) {
    return { ...payload, thinking: { type: 'disabled' } }
  }
  const next: Record<string, unknown> = {
    ...payload,
    thinking: { type: 'enabled' },
  }
  if (effort && (effort === 'low' || effort === 'high' || effort === 'max')) {
    next.output_config = { effort }
  }
  return next
}

/**
 * @deprecated Parent turns no longer swap onto the vision SKU. Images are
 * routed through `call_agent` (`src/core/vision-route.ts`). Kept as a
 * no-op so leftover callers cannot reintroduce the auto-swap.
 */
export function applyDeepSeekVisionModel<M extends {
  id: string
  name: string
  baseUrl?: string
  input: Array<'text' | 'image'>
}>(model: M, _hasImages: boolean): M {
  return model
}

/** Env / config: enable DeepSeek beta strict tools. */
export function isDeepSeekStrictToolsEnabled(
  backendFlag: boolean | undefined,
): boolean {
  if (backendFlag === true) return true
  if (backendFlag === false) return false
  const raw = (process.env.AGIM_DEEPSEEK_STRICT_TOOLS ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}
