// OpenAI-compatible chat completions provider.
//
// One adapter covers the entire OpenAI-compatible ecosystem: OpenAI,
// DeepSeek, Moonshot/Kimi, Qwen DashScope (compat mode), MiniMax,
// StepFun, VolcEngine, LongCat, Mistral La Plateforme, Groq, Together,
// SiliconFlow, OpenRouter, vLLM, LM Studio, Ollama's OpenAI-compat
// endpoint, and any custom gateway that exposes `/v1/chat/completions`.
//
// Stage 1 scope (intentionally narrow):
//   - POST /v1/chat/completions with `messages` + optional `temperature` + `max_tokens`
//   - Standard streaming via SSE (`stream: true`)
//   - Single retry on 429 / 5xx transient errors
//   - Usage extraction (prompt_tokens / completion_tokens / total_tokens)
//
// Out of scope for Stage 1 (lands in Stage 2):
//   - structured outputs (json_schema)
//   - response_format
//
// (Stage 2 added tool_calls + vision / image_url content parts; the
// remaining items are still pending.)
//
// Why no SDK: every OpenAI-compatible vendor diverges in subtle ways and
// the official `openai` SDK adds a 5MB+ dep tree for what is ultimately
// one POST. `fetch` keeps the code auditable and dependency-free.

import {
  LlmProvider,
  LlmProviderError,
  type ChatResult,
  type ChatStreamChunk,
  type LlmMessage,
  type LlmUsage,
  type NormalizedOptions,
  type ProviderConfigBase,
  type FinishReason,
  type ToolCallRequest,
  type ToolChoice,
  type ToolDef,
} from './provider-base.js'
import {
  applyStrictToolsToOpenAiPayload,
  DEEPSEEK_OPENAI_BASE,
  isDeepSeekStrictToolsEnabled,
  normalizeJsonSchemaForStrict,
  resolveDeepSeekOpenAiBaseUrl,
} from './deepseek-compat.js'
import {
  completeDeepSeekFim,
  createDeepSeekResponse,
  type DeepSeekFimRequest,
  type DeepSeekFimResult,
  type DeepSeekResponsesRequest,
  type DeepSeekResponsesResult,
} from './deepseek-api.js'
import {
  isDeepSeekBaseUrl,
  isKimiBaseUrl,
  isKimiK2Model,
  isKimiK3Model,
  isMimoBaseUrl,
  isZhipuBaseUrl,
} from './presets.js'
import { statSync as fsStatSync, readFileSync as fsReadFileSync } from 'node:fs'

export interface OpenAICompatProviderConfig extends Omit<ProviderConfigBase, 'providerType'> {
  /** Full base URL up to (but not including) `/chat/completions`. Each
   *  vendor publishes its own; we default to OpenAI's. Examples:
   *    - OpenAI:       https://api.openai.com/v1
   *    - DeepSeek:     https://api.deepseek.com
   *    - Kimi/Moonshot: https://api.moonshot.cn/v1 (intl: api.moonshot.ai/v1)
   *    - Qwen compat:  https://dashscope.aliyuncs.com/compatible-mode/v1
   *    - Ollama:       http://localhost:11434/v1
   *    - vLLM:         http://localhost:8000/v1
   *    - OpenRouter:   https://openrouter.ai/api/v1
   */
  baseUrl?: string
  /** Headers merged into every request. Useful for OpenRouter's
   *  `HTTP-Referer` / `X-Title`, Azure's `api-key`, etc. The Authorization
   *  header is set automatically from `apiKey` and cannot be overridden
   *  here — that would defeat the secrets layer. */
  extraHeaders?: Record<string, string>
  /** Number of retries on transient (429 / 5xx) failures. Default 1.
   *  Caller-side retry budgets (audit / cost) make >2 wasteful. */
  retryOnTransient?: number
  /** Display label for logs / web UI. Defaults to "openai-compat" but
   *  individual deployments may want "deepseek" / "kimi" / "qwen" so the
   *  cost dashboard groups correctly. */
  providerLabel?: string
  /**
   * Which max-tokens field to emit. Some OpenAI-compat gateways (Kimi K3,
   * MiMo, custom proxies) only accept `max_completion_tokens`.
   * Default: `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Operator opt-in: this provider's configured model understands the
   *  OpenAI vision content shape ({type:'image_url'} blocks). When true,
   *  `LlmMessage.media` is encoded into the request; otherwise media is
   *  silently ignored and only the text path travels.
   *  Default heuristic: true if the model id contains 'vision', 'gpt-4o',
   *  'gpt-4.1', 'qwen-vl', or 'glm-4v'. Override explicitly when needed. */
  vision?: boolean
  /**
   * DeepSeek: use beta base + `strict: true` tool schemas. Also enabled
   * when `AGIM_DEEPSEEK_STRICT_TOOLS=1`.
   */
  strictTools?: boolean
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_RETRY = 3
const BASE_BACKOFF_MS = 250
/** DeepSeek concurrency (Pro 500 / Flash 2500) + peak pricing → wait longer on 429. */
const DEEPSEEK_BACKOFF_MS = 750
const MAX_BACKOFF_MS = 30_000

/** Parse an HTTP `Retry-After` header per RFC 9110: either delta-seconds
 *  (e.g. "30") or an HTTP-date. Returns ms-from-now, clamped to ≥0.
 *  Returns null on null / empty / unparsable. Exported for unit tests. */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null
  const s = String(header).trim()
  if (!s) return null
  // delta-seconds form
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n * 1000)
    return null
  }
  // HTTP-date form (RFC 1123 etc.). Gate by length first: every RFC 7231
  // HTTP-date variant (IMF-fixdate / obs-RFC850 / ANSI C asctime) is ≥24
  // chars; without this gate Node's `Date.parse` loosely accepts e.g.
  // "-5" as "5 BC" and `Math.max(0, …)` would swallow it as 0.
  if (s.length < 20) return null
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  return Math.max(0, t - Date.now())
}

/** Compute backoff for retry `attempt` (1-based). Honors any `Retry-After`
 *  the server sent — we wait at least that long (server knows when it's
 *  next available). Exponential 250ms × 2^(attempt-1) with full jitter
 *  on top to spread thundering herd. Capped at 30s — anything longer and
 *  the worker is better off surrendering to the caller's fallback path.
 *  `nowJitter` is injectable for deterministic tests. */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  opts: { base?: number; cap?: number; jitter?: () => number } = {},
): number {
  const base = opts.base ?? BASE_BACKOFF_MS
  const cap = opts.cap ?? MAX_BACKOFF_MS
  const jitter = opts.jitter ?? (() => 0.8 + Math.random() * 0.4)
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  const withJitter = Math.floor(exp * jitter())
  const floor = Math.max(0, retryAfterMs ?? 0)
  return Math.min(cap, Math.max(floor, withJitter))
}

function resolveDefaultRetry(): number {
  const raw = process.env.AGIM_LLM_RETRY_MAX
  if (!raw) return DEFAULT_RETRY
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY
  return Math.min(10, Math.floor(n))
}

/**
 * Concrete provider for any OpenAI-compatible `/v1/chat/completions`
 * endpoint. Single-shot chat is the only Stage-1 path we care about —
 * the streaming method is wired up for Stage 2 / future "show thinking
 * in web UI" features and is fully functional.
 */
export class OpenAICompatProvider extends LlmProvider {
  private readonly baseUrl: string
  private readonly extraHeaders: Record<string, string>
  private readonly retryOnTransient: number
  private readonly vision: boolean
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens'
  private readonly backoffBaseMs: number
  private readonly strictTools: boolean

  constructor(cfg: OpenAICompatProviderConfig) {
    super({
      ...cfg,
      providerType: cfg.providerLabel || 'openai-compat',
    })
    let base = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.strictTools = isDeepSeekStrictToolsEnabled(cfg.strictTools)
      && isDeepSeekBaseUrl(base)
    // Strict tools / prefix / FIM require the DeepSeek beta host.
    if (this.strictTools && isDeepSeekBaseUrl(base) && !/\/beta$/i.test(base)) {
      base = resolveDeepSeekOpenAiBaseUrl({ strictTools: true })
    }
    this.baseUrl = base
    this.extraHeaders = cfg.extraHeaders || {}
    this.retryOnTransient = Math.max(0, Math.min(10, cfg.retryOnTransient ?? resolveDefaultRetry()))
    this.backoffBaseMs = isDeepSeekBaseUrl(this.baseUrl) ? DEEPSEEK_BACKOFF_MS : BASE_BACKOFF_MS
    this.maxTokensField = cfg.maxTokensField === 'max_completion_tokens'
      ? 'max_completion_tokens'
      : 'max_tokens'
    if (typeof cfg.vision === 'boolean') {
      this.vision = cfg.vision
    } else {
      // Heuristic: well-known vision-capable model families.
      const m = (cfg.model || '').toLowerCase()
      this.vision = /vision|gpt-4o|gpt-4\.1|qwen-vl|glm-4v|llava/.test(m)
    }
  }

  /** DeepSeek FIM completion (beta `/completions`). */
  async completeFim(
    req: Omit<DeepSeekFimRequest, 'model'> & { model?: string },
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DeepSeekFimResult> {
    return completeDeepSeekFim(
      {
        apiKey: this.apiKey ?? '',
        baseUrl: resolveDeepSeekOpenAiBaseUrl({ beta: true }),
        extraHeaders: this.extraHeaders,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      },
      { ...req, model: req.model || this.model },
    )
  }

  /** DeepSeek / OpenAI Responses API (`POST /responses`). */
  async createResponse(
    req: Omit<DeepSeekResponsesRequest, 'model'> & { model?: string },
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DeepSeekResponsesResult> {
    const base = isDeepSeekBaseUrl(this.baseUrl)
      ? DEEPSEEK_OPENAI_BASE
      : this.baseUrl.replace(/\/beta$/i, '')
    return createDeepSeekResponse(
      {
        apiKey: this.apiKey ?? '',
        baseUrl: base,
        extraHeaders: this.extraHeaders,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      },
      { ...req, model: req.model || this.model },
    )
  }

  override supportsVision(): boolean {
    return this.vision
  }

  protected async _callApi(
    messages: LlmMessage[],
    opts: NormalizedOptions,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const body = this._buildBody(messages, opts, false)
    const json = await this._postJson(body, signal)
    const text = extractText(json)
    const finishReason = mapFinishReason(json?.choices?.[0]?.finish_reason)
    const usage = extractUsage(json)
    const toolCalls = extractToolCalls(json)
    const reasoningContent = extractReasoningContent(json)
    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoningContent,
      usage,
      finishReason,
      modelUsed: typeof json?.model === 'string' ? json.model : opts.model,
    }
  }

  protected async *_callApiStream(
    messages: LlmMessage[],
    opts: NormalizedOptions,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const body = this._buildBody(messages, opts, true)
    const url = this.chatCompletionsUrl(body)
    const resp = await this._fetchWithRetry(url, body, signal)
    if (!resp.body) {
      throw new LlmProviderError(this.name, 'streaming response had no body', { httpStatus: resp.status })
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let lastUsage: LlmUsage | undefined
    let lastFinish: FinishReason | undefined
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are separated by blank lines (`\n\n`); each frame
        // contains one or more `data: <json>` lines.
        for (;;) {
          const sep = buffer.indexOf('\n\n')
          if (sep === -1) break
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          for (const line of frame.split('\n')) {
            const trimmed = line.trim()
            // DeepSeek (and others) emit SSE comment keep-alives (`: keep-alive`)
            // and blank lines while queued — skip anything that isn't `data:`.
            if (!trimmed || trimmed.startsWith(':')) continue
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') {
              yield { textDelta: '', finishReason: lastFinish ?? 'stop', usage: lastUsage }
              return
            }
            let parsed: ChatCompletionChunk | null = null
            try { parsed = JSON.parse(payload) as ChatCompletionChunk } catch { /* ignore */ }
            if (!parsed) continue
            const choice = parsed.choices?.[0]
            const delta = choice?.delta?.content
            if (parsed.usage) lastUsage = extractUsage(parsed)
            if (choice?.finish_reason) {
              lastFinish = mapFinishReason(choice.finish_reason)
            }
            // v1.2.112 — emit tool_call + reasoning deltas. OpenAI
            // streams tool_calls split across chunks: first chunk for
            // an `index` carries id+name, subsequent chunks add
            // `function.arguments` fragments. Pass through as-is and
            // let the consumer accumulate by index.
            const deltaObj = choice?.delta as {
              content?: string
              tool_calls?: Array<{
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
              reasoning_content?: string
            } | undefined
            const toolCallDeltas = (deltaObj?.tool_calls ?? [])
              .filter((tc) => tc && typeof tc.index === 'number')
              .map((tc) => ({
                index: tc.index as number,
                id: tc.id,
                name: tc.function?.name,
                argumentsDelta: tc.function?.arguments,
              }))
            const reasoningDelta = typeof deltaObj?.reasoning_content === 'string' && deltaObj.reasoning_content.length > 0
              ? deltaObj.reasoning_content
              : undefined
            const textDeltaStr = typeof delta === 'string' ? delta : ''
            if (textDeltaStr || toolCallDeltas.length > 0 || reasoningDelta) {
              yield {
                textDelta: textDeltaStr,
                toolCallDeltas: toolCallDeltas.length > 0 ? toolCallDeltas : undefined,
                reasoningDelta,
              }
            }
          }
        }
      }
      // Stream ended without `[DONE]` (some vendors do this) — surface
      // the trailing state so callers still see a finalized chunk.
      yield { textDelta: '', finishReason: lastFinish ?? 'stop', usage: lastUsage }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
  }

  /**
   * Compose the JSON body. Kept tiny on purpose — the messages array
   * goes through as-is and the rest of the OpenAI surface (logprobs,
   * top_p, stop, …) lands when callers ask for it via providerOptions.
   */
  private _buildBody(
    messages: LlmMessage[],
    opts: NormalizedOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: messages.map((m) => serializeMessage(m, { vision: this.vision })),
      [this.maxTokensField]: opts.maxTokens,
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    if (stream) body.stream = true
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => serializeToolDef(t, { strict: this.strictTools }))
      const tc = serializeToolChoice(opts.toolChoice)
      if (tc !== undefined) body.tool_choice = tc
    }
    // Chat Prefix Completion: last assistant message with prefix:true forces beta host.
    const wantsPrefix = messages.some((m) => m.role === 'assistant' && m.prefix === true)
    if (wantsPrefix && isDeepSeekBaseUrl(this.baseUrl) && !/\/beta$/i.test(this.baseUrl)) {
      // Mutating base mid-call is awkward; rewrite URL in _fetchWithRetry via body flag.
      body.__agim_deepseek_beta = true
    }
    if (this.strictTools && opts.tools && opts.tools.length > 0) {
      Object.assign(body, applyStrictToolsToOpenAiPayload(body))
    }
    // DeepSeek / Kimi K2.x / Zhipu GLM / MiMo defaults for the OpenAICompat
    // path (ping / introspection / evaluator): thinking OFF unless the
    // caller opts in. Agim Agent (pi) owns the interactive thinking-mode path.
    // Kimi K3 always thinks (reasoning_effort) — never send thinking.type.
    if (
      isDeepSeekBaseUrl(this.baseUrl)
      && opts.providerOptions.thinking === undefined
    ) {
      body.thinking = { type: 'disabled' }
    }
    if (
      isKimiBaseUrl(this.baseUrl)
      && isKimiK2Model(opts.model)
      && opts.providerOptions.thinking === undefined
    ) {
      body.thinking = { type: 'disabled' }
    }
    if (
      isZhipuBaseUrl(this.baseUrl)
      && opts.providerOptions.thinking === undefined
    ) {
      body.thinking = { type: 'disabled' }
    }
    if (
      isMimoBaseUrl(this.baseUrl)
      && opts.providerOptions.thinking === undefined
    ) {
      body.thinking = { type: 'disabled' }
    }
    // providerOptions lets callers pass through e.g. {top_p: 0.9} or
    // DeepSeek's {response_format: {type:'json_object'}} without
    // requiring a release of this file every time a vendor adds a knob.
    for (const [k, v] of Object.entries(opts.providerOptions)) {
      if (v !== undefined) body[k] = v
    }
    // DeepSeek `user_id` (hashed) may be supplied via providerOptions — see
    // deepseek-compat.hashDeepSeekUserId. Never put raw PII in the body.
    // Thinking mode ignores sampling knobs — drop them so configs don't
    // silently mislead operators (DeepSeek accepts but no-ops them).
    // Kimi K3 fixes temperature/top_p/penalties server-side — omit them.
    const thinking = body.thinking as { type?: string } | undefined
    if (
      thinking?.type === 'enabled'
      || isKimiK3Model(opts.model)
      || (isKimiBaseUrl(this.baseUrl) && isKimiK3Model(opts.model))
    ) {
      delete body.temperature
      delete body.top_p
      delete body.presence_penalty
      delete body.frequency_penalty
    }
    return body
  }

  private chatCompletionsUrl(body: unknown): string {
    const bag = body && typeof body === 'object' ? body as Record<string, unknown> : null
    const forceBeta = bag?.__agim_deepseek_beta === true
    if (bag && '__agim_deepseek_beta' in bag) delete bag.__agim_deepseek_beta
    const base = forceBeta && isDeepSeekBaseUrl(this.baseUrl) && !/\/beta$/i.test(this.baseUrl)
      ? resolveDeepSeekOpenAiBaseUrl({ beta: true })
      : this.baseUrl
    return `${base}/chat/completions`
  }

  private async _postJson(body: unknown, signal: AbortSignal): Promise<ChatCompletionResponse> {
    const url = this.chatCompletionsUrl(body)
    const resp = await this._fetchWithRetry(url, body, signal)
    let json: ChatCompletionResponse
    try {
      json = await resp.json() as ChatCompletionResponse
    } catch (err) {
      throw new LlmProviderError(this.name, 'failed to parse JSON response', {
        httpStatus: resp.status,
        cause: err,
      })
    }
    return json
  }

  /**
   * fetch + transient retry with Retry-After + exponential backoff + jitter.
   * Earlier versions used a tiny fixed delay and ignored `Retry-After`,
   * which made DeepSeek / Moonshot 429s flap straight to the fallback
   * provider (cold start + model-semantics swap) instead of waiting the
   * few seconds the upstream actually asked for. We now honor the header
   * as a hard floor; exponential backoff with jitter rides on top to
   * avoid thundering-herd against the upstream's recovery window.
   *
   * Defaults: 3 retries (= 4 attempts), 250ms base, doubling per attempt,
   * capped at 30s. Override via `AGIM_LLM_RETRY_MAX` env (clamped [0,10])
   * or the `retryOnTransient` ctor option. The cap exists because beyond
   * ~30s the worker is better off surrendering so the agent loop can pick
   * a fallback provider.
   */
  private async _fetchWithRetry(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
    let lastErr: unknown
    let attempts = 0
    const maxAttempts = this.retryOnTransient + 1
    while (attempts < maxAttempts) {
      attempts++
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'agim-cli/llm-client',
          ...this.extraHeaders,
        }
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
        if (resp.ok) return resp
        const transient = resp.status === 429 || resp.status === 408 || (resp.status >= 500 && resp.status < 600)
        // Read body so we can surface a useful error message; vendor
        // error envelopes vary too much to parse reliably here.
        let bodyText = ''
        try { bodyText = (await resp.text()).slice(0, 500) } catch { /* ignore */ }
        if (!transient || attempts >= maxAttempts) {
          throw new LlmProviderError(this.name,
            `HTTP ${resp.status} from ${this.providerType}: ${bodyText || '(no body)'}`,
            { httpStatus: resp.status, transient })
        }
        const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'))
        await sleep(computeBackoffMs(attempts, retryAfterMs, { base: this.backoffBaseMs }), signal)
      } catch (err) {
        // AbortError propagates immediately — callers wired timeouts on
        // purpose and want to bail.
        if (isAbortError(err)) throw err
        lastErr = err
        if (attempts < maxAttempts) {
          // Transport errors have no Retry-After to consult.
          await sleep(computeBackoffMs(attempts, null, { base: this.backoffBaseMs }), signal)
        }
      }
    }
    if (lastErr instanceof LlmProviderError) throw lastErr
    throw new LlmProviderError(this.name,
      `transport error: ${(lastErr as Error)?.message ?? String(lastErr)}`,
      { transient: true, cause: lastErr })
  }
}

interface OpenAIToolCallFn {
  name?: string
  arguments?: string
}
interface OpenAIToolCall {
  id?: string
  type?: string
  function?: OpenAIToolCallFn
}
interface ChatCompletionChoiceMessage {
  role?: string
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  reasoning_content?: string | null
}

interface ChatCompletionChoice {
  index?: number
  message?: ChatCompletionChoiceMessage
  delta?: { content?: string | null }
  finish_reason?: string | null
}

interface ChatCompletionUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** DeepSeek context-cache hit / miss (prompt_tokens = hit + miss). */
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  /** Some vendors include cost directly (e.g. OpenRouter), most don't. */
  cost?: number
  total_cost?: number
}

interface ChatCompletionResponse {
  model?: string
  choices?: ChatCompletionChoice[]
  usage?: ChatCompletionUsage
}

interface ChatCompletionChunk {
  model?: string
  choices?: ChatCompletionChoice[]
  usage?: ChatCompletionUsage
}

function extractReasoningContent(json: ChatCompletionResponse | null): string | undefined {
  const r = json?.choices?.[0]?.message?.reasoning_content
  return typeof r === 'string' && r.length > 0 ? r : undefined
}

function extractText(json: ChatCompletionResponse | null): string {
  const c = json?.choices?.[0]?.message?.content
  if (typeof c === 'string') return c
  return ''
}

function extractUsage(json: { usage?: ChatCompletionUsage } | null): LlmUsage {
  const u = json?.usage
  if (!u) return {}
  const result: LlmUsage = {
    promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
    totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
  }
  const cacheHit = typeof u.prompt_cache_hit_tokens === 'number'
    ? u.prompt_cache_hit_tokens
    : typeof u.prompt_tokens_details?.cached_tokens === 'number'
      ? u.prompt_tokens_details.cached_tokens
      : undefined
  if (typeof cacheHit === 'number') result.cacheReadTokens = cacheHit
  if (typeof u.prompt_cache_miss_tokens === 'number') {
    result.cacheMissTokens = u.prompt_cache_miss_tokens
  }
  const cost = typeof u.cost === 'number' ? u.cost
    : typeof u.total_cost === 'number' ? u.total_cost
    : undefined
  if (cost !== undefined) result.costUsd = cost
  return result
}

function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop': return 'stop'
    case 'length': return 'length'
    case 'content_filter': return 'content_filter'
    case 'tool_calls': return 'tool_use'   // Stage 2 — agent loop iterates on this
    case 'function_call': return 'tool_use'
    case null:
    case undefined:
    case '': return 'unknown'
    default: return 'unknown'
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError'
}

// ─── Stage 2 — tool-call serialization / deserialization ─────────────

function serializeMessage(m: LlmMessage, opts: { vision: boolean }): Record<string, unknown> {
  // OpenAI's wire-format expects either:
  //   - {role:'system'|'user', content}
  //   - {role:'assistant', content, tool_calls?: [...]}
  //   - {role:'tool', tool_call_id, content}
  // We branch on role to put fields in the right shape, otherwise the
  // API politely 400s with very unhelpful errors.
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId ?? '',
      content: m.content,
    }
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    const out: Record<string, unknown> = {
      role: 'assistant',
      // content may be empty when the assistant emitted only tool_calls.
      // OpenAI requires the key to be present (use null over '').
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.argumentsRaw ?? JSON.stringify(tc.arguments),
        },
      })),
    }
    if (m.reasoningContent) out.reasoning_content = m.reasoningContent
    if (m.prefix) out.prefix = true
    return out
  }
  if (m.role === 'assistant' && m.reasoningContent) {
    const out: Record<string, unknown> = {
      role: 'assistant',
      content: m.content || null,
      reasoning_content: m.reasoningContent,
    }
    if (m.prefix) out.prefix = true
    return out
  }
  if (m.role === 'assistant' && m.prefix) {
    return { role: 'assistant', content: m.content || null, prefix: true }
  }
  // User / system path. Encode media as image_url content blocks when
  // the provider declared vision support; otherwise drop the media
  // (the text path already mentions the attachment by path so the
  // model can still acknowledge it textually).
  if (opts.vision && m.media && m.media.length > 0 && m.role === 'user') {
    const blocks: Array<Record<string, unknown>> = []
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const item of m.media) {
      const dataUrl = mediaToDataUrl(item.path, item.mime)
      if (dataUrl) blocks.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
    if (blocks.length > 0) return { role: 'user', content: blocks }
  }
  return { role: m.role, content: m.content }
}

/** Read a local file and inline-base64 it as a data URL. Returns null
 *  on read failure so the caller can fall back to text-only. Capped at
 *  20MB — most IM attachments are well under, and oversize files would
 *  blow past most providers' request-size limits anyway. */
function mediaToDataUrl(path: string, mimeHint?: string): string | null {
  try {
    const stat = fsStatSync(path)
    if (stat.size > 20 * 1024 * 1024) return null
    const buf = fsReadFileSync(path)
    const mime = mimeHint || sniffMime(path)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function sniffMime(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

function serializeToolDef(
  t: ToolDef,
  opts: { strict?: boolean } = {},
): Record<string, unknown> {
  const parameters = opts.strict
    ? normalizeJsonSchemaForStrict(t.parameters)
    : t.parameters
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters,
      ...(opts.strict ? { strict: true } : {}),
    },
  }
}

function serializeToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

function extractToolCalls(json: ChatCompletionResponse | null): ToolCallRequest[] {
  const calls = json?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(calls) || calls.length === 0) return []
  const out: ToolCallRequest[] = []
  for (const c of calls) {
    const id = typeof c?.id === 'string' ? c.id : ''
    const name = typeof c?.function?.name === 'string' ? c.function.name : ''
    const rawArgs = typeof c?.function?.arguments === 'string' ? c.function.arguments : ''
    if (!id || !name) continue
    let parsed: Record<string, unknown> = {}
    let argumentsRaw: string | undefined
    if (rawArgs) {
      try {
        const obj = JSON.parse(rawArgs) as unknown
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          parsed = obj as Record<string, unknown>
        } else {
          argumentsRaw = rawArgs
        }
      } catch {
        // Model emitted malformed JSON. Surface the raw text so tools
        // can decide whether to error or to attempt a salvage.
        argumentsRaw = rawArgs
      }
    }
    const req: ToolCallRequest = { id, name, arguments: parsed }
    if (argumentsRaw !== undefined) req.argumentsRaw = argumentsRaw
    out.push(req)
  }
  return out
}
