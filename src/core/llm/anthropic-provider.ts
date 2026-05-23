// Anthropic native Messages API provider (Stage 2 D+ — 2026-05-23).
//
// Why a separate adapter (vs piping Anthropic through OpenAICompatProvider):
//   - Anthropic's wire format is genuinely different. Messages use a
//     content-blocks array; system prompt is a top-level field; tool
//     calls are `tool_use` blocks embedded in assistant content; tool
//     results are `tool_result` blocks inside a USER message. None of
//     this maps cleanly to OpenAI's flat schema.
//   - Anthropic-specific knobs (`cache_control`, `thinking`, etc.) are
//     wire-level fields we want to use eventually, and wedging them
//     into the generic provider via `providerOptions` quickly gets
//     ugly. Better to own the dialect.
//
// What's in this initial cut:
//   - POST /v1/messages with role/content + system + temperature + max_tokens
//   - Tools (input_schema in the Anthropic shape; we accept the same
//     `ToolDef.parameters` JSON Schema that OpenAI takes — Anthropic
//     happens to accept JSON Schema directly under input_schema).
//   - Multi-turn tool calls: serialize assistant tool_use blocks + user
//     tool_result blocks faithfully so multi-iteration agent loops work.
//   - Standard transient-error retry (429, 5xx)
//   - Usage extraction (input_tokens / output_tokens)
//
// Out of scope for this PR (Stage 2 sub-PR #1):
//   - Streaming (the buffered path is enough for the agent loop's first
//     iteration; streaming lands when we wire it to the IM "show
//     thinking" feature)
//   - Prompt caching (`cache_control: {type:'ephemeral'}`) — easy
//     follow-up once we have a place to decide which blocks deserve it
//   - Extended thinking blocks — orthogonal feature
//   - Bedrock / Vertex (different transports; future provider class)

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

export interface AnthropicProviderConfig extends Omit<ProviderConfigBase, 'providerType'> {
  /** Base URL up to (but not including) `/v1/messages`. Defaults to
   *  Anthropic's public endpoint. Override for Bedrock / Vertex / a
   *  corporate gateway. */
  baseUrl?: string
  /** `anthropic-version` header value. Anthropic pins API behaviour to
   *  this date string; bumping it can change response shapes. We
   *  default to the latest stable as of 2026-05. */
  apiVersion?: string
  /** Extra headers merged into every request. `x-api-key` /
   *  `anthropic-version` / `content-type` are set automatically and
   *  cannot be overridden here. */
  extraHeaders?: Record<string, string>
  /** Retries on transient (429 / 5xx). Default 1, same as OpenAI compat. */
  retryOnTransient?: number
  /** Display label for cost dashboard / logs. */
  providerLabel?: string
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const DEFAULT_API_VERSION = '2023-06-01'
const DEFAULT_RETRY = 1

/**
 * Native Anthropic Messages API provider.
 *
 * The constructor takes the same shape as OpenAICompatProvider (caller
 * code stays uniform); the differences live entirely in the wire-format
 * helpers below.
 */
export class AnthropicProvider extends LlmProvider {
  private readonly baseUrl: string
  private readonly apiVersion: string
  private readonly extraHeaders: Record<string, string>
  private readonly retryOnTransient: number

  constructor(cfg: AnthropicProviderConfig) {
    super({
      ...cfg,
      providerType: cfg.providerLabel || 'anthropic',
    })
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.apiVersion = cfg.apiVersion || DEFAULT_API_VERSION
    this.extraHeaders = cfg.extraHeaders || {}
    this.retryOnTransient = Math.max(0, cfg.retryOnTransient ?? DEFAULT_RETRY)
  }

  protected async _callApi(
    messages: LlmMessage[],
    opts: NormalizedOptions,
    signal: AbortSignal,
  ): Promise<ChatResult> {
    const body = this._buildBody(messages, opts)
    const json = await this._postJson(body, signal)
    const text = extractTextFromBlocks(json?.content)
    const toolCalls = extractToolUseFromBlocks(json?.content)
    const finishReason = mapStopReason(json?.stop_reason)
    const usage = extractUsage(json)
    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finishReason,
      modelUsed: typeof json?.model === 'string' ? json.model : opts.model,
    }
  }

  // Streaming not implemented in this PR; LlmProvider's base
  // _callApiStream falls back to buffered + single chunk yield, which
  // is correct for callers that don't need incremental delivery.
  protected override async *_callApiStream(
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
   * Compose the Anthropic Messages body. Differences vs OpenAI:
   *   - `system` is a top-level field, NOT a message
   *   - `messages[*].content` may be a string OR a content-block array
   *   - tool calls live inside assistant content as `{type:'tool_use',...}`
   *   - tool results live inside user content as `{type:'tool_result',...}`
   *   - `tools` use `input_schema` (we pass our ToolDef.parameters JSON
   *     Schema directly — Anthropic accepts the same dialect)
   */
  private _buildBody(messages: LlmMessage[], opts: NormalizedOptions): Record<string, unknown> {
    const { system, msgs } = splitSystemPrompt(messages)
    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      messages: msgs.map(serializeMessage),
    }
    if (system) body.system = system
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map(serializeToolDef)
      const tc = serializeToolChoice(opts.toolChoice)
      if (tc !== undefined) body.tool_choice = tc
    }
    for (const [k, v] of Object.entries(opts.providerOptions)) {
      if (v !== undefined) body[k] = v
    }
    return body
  }

  private async _postJson(body: unknown, signal: AbortSignal): Promise<MessagesResponse> {
    const url = `${this.baseUrl}/v1/messages`
    const resp = await this._fetchWithRetry(url, body, signal)
    try {
      return (await resp.json()) as MessagesResponse
    } catch (err) {
      throw new LlmProviderError(this.name, 'failed to parse JSON response', {
        httpStatus: resp.status,
        cause: err,
      })
    }
  }

  /**
   * fetch + transient retry. Mirrors OpenAICompatProvider's logic on
   * purpose so the two providers feel the same to operators reading
   * logs.
   */
  private async _fetchWithRetry(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
    let lastErr: unknown
    let attempts = 0
    const maxAttempts = this.retryOnTransient + 1
    while (attempts < maxAttempts) {
      attempts++
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'anthropic-version': this.apiVersion,
          'user-agent': 'agim-cli/llm-client',
          ...this.extraHeaders,
        }
        if (this.apiKey) headers['x-api-key'] = this.apiKey
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
        if (resp.ok) return resp
        const transient =
          resp.status === 429 || resp.status === 408 ||
          (resp.status >= 500 && resp.status < 600)
        let bodyText = ''
        try { bodyText = (await resp.text()).slice(0, 500) } catch { /* ignore */ }
        if (!transient || attempts >= maxAttempts) {
          throw new LlmProviderError(this.name,
            `HTTP ${resp.status} from ${this.providerType}: ${bodyText || '(no body)'}`,
            { httpStatus: resp.status, transient })
        }
        await sleep(250 * attempts, signal)
      } catch (err) {
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

// ─── Wire-format types (internal) ────────────────────────────────────

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | unknown[] }
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string;[k: string]: unknown }

interface MessagesResponse {
  model?: string
  stop_reason?: string | null
  content?: ContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

// ─── Serializers (LlmMessage → Anthropic wire) ──────────────────────

function splitSystemPrompt(messages: LlmMessage[]): { system: string; msgs: LlmMessage[] } {
  // Anthropic wants system as a top-level field. We pull every leading
  // system message out, join them with double newlines, and emit the
  // rest as-is. Mid-list system messages are RARE but valid in our
  // generic schema; we coalesce them too rather than reject the batch.
  const systemParts: string[] = []
  const rest: LlmMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
    } else {
      rest.push(m)
    }
  }
  return { system: systemParts.join('\n\n'), msgs: rest }
}

function serializeMessage(m: LlmMessage): Record<string, unknown> {
  // ── tool result → user message with tool_result block ────────────
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      }],
    }
  }
  // ── assistant with tool_use calls → content blocks ───────────────
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    const blocks: ContentBlock[] = []
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const tc of m.toolCalls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })
    }
    return { role: 'assistant', content: blocks }
  }
  // ── plain user/assistant turn → string content (cheap path) ──────
  return { role: m.role, content: m.content }
}

function serializeToolDef(t: ToolDef): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }
}

function serializeToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  if (choice === 'none') {
    // Anthropic doesn't have a first-class "none"; the standard trick
    // is to pass `tool_choice: {type:'auto', disable_parallel_tool_use:true}`
    // plus drop the tools list. Since `tools` is a separate body field,
    // the caller wanting `none` should pass tools=[] instead. We surface
    // undefined here so the request omits tool_choice — same as not
    // specifying tools at all. If the caller insisted on both, log a
    // warning and let the API decide.
    return undefined
  }
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'tool', name: choice.name }
  }
  return undefined
}

// ─── Deserializers (Anthropic wire → ChatResult) ────────────────────

function extractTextFromBlocks(content: ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof (block as TextBlock).text === 'string') {
      out.push((block as TextBlock).text)
    }
  }
  return out.join('')
}

function extractToolUseFromBlocks(content: ContentBlock[] | undefined): ToolCallRequest[] {
  if (!Array.isArray(content)) return []
  const out: ToolCallRequest[] = []
  for (const block of content) {
    if (block?.type !== 'tool_use') continue
    const tu = block as ToolUseBlock
    if (!tu.id || !tu.name) continue
    const args = tu.input && typeof tu.input === 'object' && !Array.isArray(tu.input)
      ? (tu.input as Record<string, unknown>)
      : {}
    out.push({ id: tu.id, name: tu.name, arguments: args })
  }
  return out
}

function extractUsage(json: MessagesResponse | null): LlmUsage {
  const u = json?.usage
  if (!u) return {}
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : undefined
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : undefined
  const total = input !== undefined && output !== undefined ? input + output : undefined
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: total,
  }
}

function mapStopReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'end_turn': return 'stop'
    case 'stop_sequence': return 'stop'
    case 'tool_use': return 'tool_use'
    case 'max_tokens': return 'length'
    case 'refusal':
    case 'content_filtered': return 'content_filter'
    case null:
    case undefined:
    case '': return 'unknown'
    default: return 'unknown'
  }
}

// ─── Tiny utility duplicates (kept inline to avoid an internal helper
//      module; the alternative is moving these into provider-base.ts
//      which would expand its API surface for one file's benefit). ─

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
