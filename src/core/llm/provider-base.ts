// LLM provider abstraction (Stage 1 — D+ plan, 2026-05-23).
//
// The goal here is intentionally small: give agim a way to do
// "single-shot LLM call → text" *without* spawning a CLI agent (Claude
// Code / Codex / OpenCode). agim stays a CLI bridge in spirit — these
// providers are only used by internal introspection callers
// (memory-distill, memory-consolidate, intent-llm, future heartbeat /
// notification evaluator).
//
// Stage 1 explicitly does NOT implement:
//   - tool calling / agent loop (that's Stage 2)
//   - MCP client (Stage 2)
//   - file / shell tools (delegated to MCP in Stage 2)
//   - Anthropic native messages API (Stage 2)
//
// What it DOES support:
//   - `chat(messages, opts) → ChatResult` for buffered text responses
//   - `chatStream(...)` async iterable for incremental delivery
//   - timeouts via AbortSignal
//   - usage / cost telemetry surfaced through onUsage callback
//
// Concrete providers (Stage 1: OpenAICompatProvider only) subclass and
// implement `_callApi` / `_callApiStream`. The base wraps with timeout +
// telemetry plumbing so providers stay focused on transport details.

/**
 * Chat message role. We intentionally support only the three canonical
 * roles needed by introspection callers; tool / function roles arrive in
 * Stage 2 when we add the real agent loop.
 */
export type LlmMessageRole = 'system' | 'user' | 'assistant'

/** Single chat message as sent to the LLM provider. */
export interface LlmMessage {
  role: LlmMessageRole
  content: string
}

/** Token + cost usage surfaced by the provider, when available. */
export interface LlmUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Cost in USD if the provider reports it; otherwise undefined. We
   *  deliberately don't try to compute cost from a hardcoded price table
   *  — Stage 1 just passes through whatever the provider says. */
  costUsd?: number
}

/** Reason the model stopped generating. */
export type FinishReason =
  | 'stop'        // normal end-of-message
  | 'length'      // max tokens reached
  | 'content_filter'
  | 'error'
  | 'unknown'

/** Per-call options. All fields are optional with sensible defaults. */
export interface ChatOptions {
  /** Override the provider's default model for this call. */
  model?: string
  /** Sampling temperature. Default = provider default (usually 0.7). */
  temperature?: number
  /** Max tokens in the completion. Default = provider default. */
  maxTokens?: number
  /** Optional system prompt to prepend (a convenience over building a
   *  system message yourself; ignored if messages already starts with
   *  a system message). */
  system?: string
  /** Abort the request when this signal fires. Required by callers that
   *  manage their own deadlines (memory-consolidate has a 60s cap). */
  signal?: AbortSignal
  /** Internal hard deadline in ms. If both signal and timeoutMs are
   *  given, the earlier of the two wins. */
  timeoutMs?: number
  /** Called once per provider response (or once per chunk for stream)
   *  with whatever usage info the provider returned. Best-effort —
   *  callers should not block on this. */
  onUsage?: (usage: LlmUsage) => void
  /** Extra provider-specific knobs. Each provider documents what it
   *  reads from this bag; unknown keys are ignored. Keeps the public
   *  ChatOptions type stable while letting power users tune
   *  OpenRouter-style headers, DeepSeek-specific thinking mode, etc. */
  providerOptions?: Record<string, unknown>
}

/** Result of a chat call. */
export interface ChatResult {
  /** Plain text body. May be the empty string on `finishReason: 'error'`. */
  text: string
  /** Usage metrics, when the provider reports them. */
  usage: LlmUsage
  /** Why the model stopped. */
  finishReason: FinishReason
  /** Model id the provider actually used (handy for diagnostics when
   *  the caller relies on the provider's default rather than an explicit
   *  `opts.model`). */
  modelUsed: string
}

/** Lightweight stream chunk. Stage 1 streams only text deltas. */
export interface ChatStreamChunk {
  textDelta: string
  /** Only populated on the final chunk. Earlier chunks have null. */
  finishReason?: FinishReason | null
  /** Only populated on the final chunk, when the provider reports it. */
  usage?: LlmUsage
}

/**
 * Common configuration every provider needs. Concrete providers may add
 * their own fields (e.g. OpenAICompatProvider adds `baseUrl`).
 */
export interface ProviderConfigBase {
  /** Unique identifier within an agim instance — e.g. "deepseek-cheap"
   *  or "gpt-4-1-judge". This is what `llmRoles` references. */
  name: string
  /** Default model id the provider sends when ChatOptions.model is unset. */
  model: string
  /** Provider type label, surfaced in logs and the web UI. */
  providerType: string
  /** API key — provider implementations look this up via secrets.ts; the
   *  base class only uses it for logging length / fingerprinting. */
  apiKey?: string
  /** Default temperature; falls back to 0.3 for cheap introspection
   *  callers (we want deterministic JSON, not creativity). */
  defaultTemperature?: number
  /** Default max output tokens. Tight default so a misconfigured prompt
   *  can't burn 16k tokens worth of "Sure! Let me explain…". */
  defaultMaxTokens?: number
}

/**
 * Base class for every LLM provider. The transport-specific work happens
 * in `_callApi` / `_callApiStream` which subclasses implement. The base
 * adds:
 *   - timeout / AbortSignal merging
 *   - default system prompt injection
 *   - onUsage plumbing (callers shouldn't have to defend against missing
 *     usage info)
 *   - finishReason normalization
 */
export abstract class LlmProvider {
  readonly name: string
  readonly model: string
  readonly providerType: string
  protected readonly apiKey: string | undefined
  protected readonly defaultTemperature: number
  protected readonly defaultMaxTokens: number

  constructor(cfg: ProviderConfigBase) {
    if (!cfg.name) throw new Error('LlmProvider: name is required')
    if (!cfg.model) throw new Error('LlmProvider: model is required')
    if (!cfg.providerType) throw new Error('LlmProvider: providerType is required')
    this.name = cfg.name
    this.model = cfg.model
    this.providerType = cfg.providerType
    this.apiKey = cfg.apiKey
    this.defaultTemperature = cfg.defaultTemperature ?? 0.3
    this.defaultMaxTokens = cfg.defaultMaxTokens ?? 1024
  }

  /** True when the provider has the credentials it needs. False suggests
   *  the operator forgot to set the secret; the registry filters these
   *  out at load time so `getProvider()` callers don't have to check. */
  isConfigured(): boolean {
    return Boolean(this.apiKey)
  }

  /**
   * Buffered chat call: send the full message list, await the entire
   * response. Used by all Stage-1 introspection callers because the
   * downstream parsers want a complete JSON string anyway.
   */
  async chat(messages: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const prepared = this._prepareMessages(messages, opts)
    const merged = this._mergeOptions(opts)
    const signal = this._buildSignal(opts.signal, merged.timeoutMs)
    const result = await this._callApi(prepared, merged, signal.signal)
    signal.cleanup()
    if (opts.onUsage) {
      try { opts.onUsage(result.usage) } catch { /* swallow — telemetry is best-effort */ }
    }
    return result
  }

  /**
   * Streaming chat call: async-iterable of text deltas. Stage-1 callers
   * don't use this yet, but it's in the base API so Stage 2's agent loop
   * (and the future "stream thinking to web UI" feature) can build on it
   * without API churn.
   */
  async *chatStream(messages: LlmMessage[], opts: ChatOptions = {}): AsyncIterable<ChatStreamChunk> {
    const prepared = this._prepareMessages(messages, opts)
    const merged = this._mergeOptions(opts)
    const signal = this._buildSignal(opts.signal, merged.timeoutMs)
    try {
      let lastUsage: LlmUsage | undefined
      for await (const chunk of this._callApiStream(prepared, merged, signal.signal)) {
        if (chunk.usage) lastUsage = chunk.usage
        yield chunk
      }
      if (lastUsage && opts.onUsage) {
        try { opts.onUsage(lastUsage) } catch { /* swallow */ }
      }
    } finally {
      signal.cleanup()
    }
  }

  /** Concrete providers implement this for buffered responses. */
  protected abstract _callApi(
    messages: LlmMessage[],
    opts: NormalizedOptions,
    signal: AbortSignal,
  ): Promise<ChatResult>

  /** Concrete providers implement this for streamed responses. Default
   *  implementation falls back to buffered + single-chunk yield, so
   *  providers that don't support streaming still work (the caller sees
   *  one big chunk on completion). Override for real streaming. */
  protected async *_callApiStream(
    messages: LlmMessage[],
    opts: NormalizedOptions,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamChunk> {
    const result = await this._callApi(messages, opts, signal)
    yield {
      textDelta: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
    }
  }

  /**
   * Prepend `opts.system` as a system message iff the caller didn't
   * already supply one. Saves callers from threading the same conditional
   * everywhere; documented in ChatOptions so behaviour is unsurprising.
   */
  private _prepareMessages(messages: LlmMessage[], opts: ChatOptions): LlmMessage[] {
    if (!opts.system) return messages
    if (messages.length > 0 && messages[0].role === 'system') return messages
    return [{ role: 'system', content: opts.system }, ...messages]
  }

  private _mergeOptions(opts: ChatOptions): NormalizedOptions {
    return {
      model: opts.model || this.model,
      temperature: opts.temperature ?? this.defaultTemperature,
      maxTokens: opts.maxTokens ?? this.defaultMaxTokens,
      timeoutMs: opts.timeoutMs,
      providerOptions: opts.providerOptions ?? {},
    }
  }

  /**
   * Merge the caller's AbortSignal with the optional timeout into a
   * single composite signal. We deliberately don't use AbortSignal.any
   * because Node 18 doesn't have it; the manual wiring is small enough
   * to keep us portable. Returns a cleanup fn the caller must invoke to
   * clear the timeout (prevents the test runner from keeping the event
   * loop alive past test completion).
   */
  private _buildSignal(
    userSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): { signal: AbortSignal; cleanup: () => void } {
    if (!userSignal && !timeoutMs) {
      // Fast path: no constraints, return a never-aborted controller so
      // _callApi has a single signal contract to work with.
      const ctrl = new AbortController()
      return { signal: ctrl.signal, cleanup: () => { /* nothing */ } }
    }
    const ctrl = new AbortController()
    let timer: NodeJS.Timeout | null = null
    const onUserAbort = () => {
      ctrl.abort(userSignal?.reason ?? new Error('aborted'))
    }
    if (userSignal) {
      if (userSignal.aborted) onUserAbort()
      else userSignal.addEventListener('abort', onUserAbort, { once: true })
    }
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => ctrl.abort(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs)
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        (timer as { unref: () => void }).unref()
      }
    }
    return {
      signal: ctrl.signal,
      cleanup: () => {
        if (timer) clearTimeout(timer)
        if (userSignal) userSignal.removeEventListener('abort', onUserAbort)
      },
    }
  }
}

/** Internal normalized form of ChatOptions — concrete providers receive
 *  this rather than the raw ChatOptions so they don't have to repeat the
 *  defaulting logic. */
export interface NormalizedOptions {
  model: string
  temperature: number
  maxTokens: number
  timeoutMs?: number
  providerOptions: Record<string, unknown>
}

/**
 * Helper for providers that want to format an error consistently. Wrapping
 * the underlying fetch / SDK error in LlmProviderError makes it easy for
 * callers (and the registry's "is the provider healthy?" probe) to tell
 * a transport failure apart from a logic bug.
 */
export class LlmProviderError extends Error {
  readonly providerName: string
  readonly httpStatus?: number
  readonly transient: boolean

  constructor(
    providerName: string,
    message: string,
    opts: { httpStatus?: number; transient?: boolean; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'LlmProviderError'
    this.providerName = providerName
    this.httpStatus = opts.httpStatus
    // 429 / 408 / 503 / 504 are conventional "retry-me" codes. Callers
    // can use this flag to decide whether to back off or fall back to a
    // CLI agent right away.
    this.transient = opts.transient ?? (
      opts.httpStatus === 408 ||
      opts.httpStatus === 429 ||
      opts.httpStatus === 503 ||
      opts.httpStatus === 504
    )
    if (opts.cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = opts.cause
    }
  }
}
