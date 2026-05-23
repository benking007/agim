// OpenAI-compatible chat completions provider.
//
// One adapter covers the entire OpenAI-compatible ecosystem: OpenAI,
// DeepSeek, Moonshot/Kimi, Qwen DashScope (compat mode), MiniMax,
// StepFun, VolcEngine, LongCat, Mistral La Plateforme, Groq, Together,
// SiliconFlow, OpenRouter, vLLM, LM Studio, Ollama's OpenAI-compat
// endpoint, and any custom gateway that exposes `/v1/chat/completions`.
//
// Stage 1 scope (intentionally narrow):
//   - POST /v1/chat/completions with `messages` + `temperature` + `max_tokens`
//   - Standard streaming via SSE (`stream: true`)
//   - Single retry on 429 / 5xx transient errors
//   - Usage extraction (prompt_tokens / completion_tokens / total_tokens)
//
// Out of scope for Stage 1 (lands in Stage 2):
//   - tool_calls / function calling
//   - structured outputs (json_schema)
//   - vision / image_url content parts
//   - response_format
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
} from './provider-base.js'

export interface OpenAICompatProviderConfig extends Omit<ProviderConfigBase, 'providerType'> {
  /** Full base URL up to (but not including) `/chat/completions`. Each
   *  vendor publishes its own; we default to OpenAI's. Examples:
   *    - OpenAI:       https://api.openai.com/v1
   *    - DeepSeek:     https://api.deepseek.com/v1
   *    - Moonshot:     https://api.moonshot.cn/v1
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
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_RETRY = 1

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

  constructor(cfg: OpenAICompatProviderConfig) {
    super({
      ...cfg,
      providerType: cfg.providerLabel || 'openai-compat',
    })
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.extraHeaders = cfg.extraHeaders || {}
    this.retryOnTransient = Math.max(0, cfg.retryOnTransient ?? DEFAULT_RETRY)
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
    return {
      text,
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
    const url = `${this.baseUrl}/chat/completions`
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
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') {
              yield { textDelta: '', finishReason: lastFinish ?? 'stop', usage: lastUsage }
              return
            }
            let parsed: ChatCompletionChunk | null = null
            try { parsed = JSON.parse(payload) as ChatCompletionChunk } catch { /* ignore */ }
            if (!parsed) continue
            const delta = parsed.choices?.[0]?.delta?.content
            if (parsed.usage) lastUsage = extractUsage(parsed)
            if (parsed.choices?.[0]?.finish_reason) {
              lastFinish = mapFinishReason(parsed.choices[0].finish_reason)
            }
            if (typeof delta === 'string' && delta.length > 0) {
              yield { textDelta: delta }
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
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }
    if (stream) body.stream = true
    // providerOptions lets callers pass through e.g. {top_p: 0.9} or
    // DeepSeek's {response_format: {type:'json_object'}} without
    // requiring a release of this file every time a vendor adds a knob.
    for (const [k, v] of Object.entries(opts.providerOptions)) {
      if (v !== undefined) body[k] = v
    }
    return body
  }

  private async _postJson(body: unknown, signal: AbortSignal): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`
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
   * fetch + minimal retry. We backoff with a tiny fixed delay rather
   * than honoring Retry-After because Stage 1 callers (distill /
   * intent) have very short deadlines — long backoffs would force a
   * fallback to CLI anyway, which is the whole point of "transient
   * retry, then surrender".
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
        // Transient and budget remaining — sleep and let the while loop
        // tick to the next attempt. The retry budget is the only thing
        // standing between us and an infinite loop.
        await sleep(250 * attempts, signal)
      } catch (err) {
        // AbortError propagates immediately — callers wired timeouts on
        // purpose and want to bail.
        if (isAbortError(err)) throw err
        lastErr = err
        if (attempts < maxAttempts) {
          await sleep(250 * attempts, signal)
        }
      }
    }
    if (lastErr instanceof LlmProviderError) throw lastErr
    throw new LlmProviderError(this.name,
      `transport error: ${(lastErr as Error)?.message ?? String(lastErr)}`,
      { transient: true, cause: lastErr })
  }
}

interface ChatCompletionChoiceMessage {
  role?: string
  content?: string | null
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
    case 'tool_calls': return 'stop'  // Stage 1 treats tool-call exits as normal stop
    case 'function_call': return 'stop'
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
