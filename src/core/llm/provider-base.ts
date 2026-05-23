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
export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * Single chat message as sent to / received from the LLM provider.
 *
 * Roles + valid combinations of fields:
 *
 *   { role: 'system'    | 'user', content }
 *     plain text turn.
 *
 *   { role: 'assistant', content, toolCalls? }
 *     model output. content may be the empty string when the model
 *     emitted only tool calls. toolCalls echoes ChatResult.toolCalls
 *     verbatim from a prior turn — required for history so the next
 *     tool-result message can reference call IDs.
 *
 *   { role: 'tool',      content, toolCallId }
 *     reply from agent code to a previous assistant tool call. content
 *     is the stringified tool result. toolCallId MUST match an id from
 *     the assistant turn's toolCalls (else providers reject the batch).
 */
export interface LlmMessage {
  role: LlmMessageRole
  content: string
  /** Required when role='tool'; ignored otherwise. */
  toolCallId?: string
  /** Required to round-trip assistant turns that contained tool calls;
   *  ignored on user/system/tool messages. Empty/undefined for plain
   *  assistant text turns. */
  toolCalls?: ToolCallRequest[]
  /** DeepSeek / thinking-mode providers echo `reasoning_content` on
   *  assistant turns; MUST round-trip on subsequent API calls. */
  reasoningContent?: string
}

/**
 * Single tool exposed to the LLM. Equivalent to OpenAI's
 * {type:'function', function:{...}} wrapper and Anthropic's {name,
 * description, input_schema} entry; providers do the dialect adapt.
 *
 * `parameters` MUST be a JSON Schema object (typically
 * `{type:'object', properties:{...}, required:[...]}`). We don't
 * validate the schema here — providers usually pass it through verbatim
 * and the LLM itself enforces the contract.
 */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * One tool call requested by the model. The Stage-2 agent loop iterates
 * over `ChatResult.toolCalls`, executes each one, then appends matching
 * `{role:'tool'}` messages and re-invokes the provider. The `id` is
 * provider-assigned (OpenAI: 'call_...', Anthropic: 'toolu_...') and
 * MUST round-trip on the tool-result message — providers reject batches
 * where ids don't match.
 *
 * `arguments` is the already-JSON-parsed input. OpenAI returns a JSON
 * string in `function.arguments`; we parse it client-side so every
 * caller sees a normal object. When the LLM emits malformed JSON the
 * provider sets `argumentsRaw` and leaves `arguments` as `{}`; tool
 * implementations should validate the shape themselves.
 *
 * `raw` is reserved for provider-specific metadata that must round-trip
 * across turns (e.g. Anthropic cache_control hints, future Gemini
 * thought signatures). The agent loop preserves it verbatim.
 */
export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** When present, JSON parsing of the arguments failed; tools should
   *  validate or refuse. Kept as a separate field so the common case
   *  (`arguments` is the parsed object) stays cheap. */
  argumentsRaw?: string
  raw?: unknown
}

/** Tool-choice hint forwarded to providers. Most providers default to
 *  'auto'; a few callers want to force a specific tool ('required' +
 *  name) or block all tool use ('none') for one call. Provider support
 *  varies — unknown values fall back to 'auto'. */
export type ToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'tool'; name: string }

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
  | 'stop'         // normal end-of-message
  | 'tool_use'     // model returned tool_calls; caller should execute + resume
  | 'length'       // max tokens reached
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
  /** Stage 2 — tool definitions advertised to the model. When unset
   *  (or empty) the model has no tool access for this call; this is
   *  the introspection-caller default and matches Stage-1 behaviour. */
  tools?: ToolDef[]
  /** Stage 2 — tool-use hint. 'auto' (default) lets the model decide;
   *  'required' forces some tool call; 'none' suppresses tools even
   *  when `tools` is non-empty; `{type:'tool', name}` forces a
   *  specific tool. Provider support varies; unknown values fall
   *  back to 'auto'. */
  toolChoice?: ToolChoice
}

/** Result of a chat call. */
export interface ChatResult {
  /** Plain text body. May be the empty string on `finishReason: 'error'`
   *  or when the model emitted only tool_calls. */
  text: string
  /** Stage 2 — tool calls the model wants the agent loop to execute.
   *  When present, finishReason is typically 'tool_use'. Stage-1
   *  introspection callers can simply ignore this field — non-empty
   *  toolCalls in a chat() call (no agent loop) just means the model
   *  spent budget on a tool the caller never advertised, which is rare
   *  but harmless. */
  toolCalls?: ToolCallRequest[]
  /** Provider-specific thinking trace (e.g. DeepSeek reasoning_content). */
  reasoningContent?: string
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
      tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
      toolChoice: opts.toolChoice,
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
  /** Stage 2 — tool definitions to advertise. Empty array → undefined
   *  so providers can rely on `opts.tools ? ... : ...` shorthand. */
  tools?: ToolDef[]
  toolChoice?: ToolChoice
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
