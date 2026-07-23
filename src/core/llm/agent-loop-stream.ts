// agent-loop-stream — streaming accumulation helpers for the agent loop.
// Extracted from agent-loop.ts; agent-loop.ts is now a re-export facade.

import { logger as rootLogger } from '../logger.js'
import type {
  ChatResult,
  FinishReason,
  LlmMessage,
  LlmUsage,
  LlmProvider,
  ToolCallRequest,
  ToolDef,
  ToolChoice,
} from './provider-base.js'
import { resolveFirstTokenRetryMax, resolveFirstTokenRetryDelayMs } from './agent-loop-config.js'

const log = rootLogger.child({ component: 'agent-loop' })

/** v1.2.138 — transient network failures we'll retry-once on the
 *  first-token path. These are the patterns we've seen in the wild
 *  from Node undici / openai-compat providers when a stream TCP drops
 *  BEFORE the first token lands (so partial text is zero). For
 *  observable consistency: keep this list tight + ordered most-
 *  specific-first. */
const TRANSIENT_STREAM_ERROR_PATTERNS = [
  /\bterminated\b/i,          // undici fetch — "TypeError: terminated"
  /\bECONNRESET\b/i,          // TCP reset mid-handshake
  /\bECONNREFUSED\b/i,        // proxy / upstream not accepting
  /\bsocket hang up\b/i,      // node http
  /\bfetch failed\b/i,        // undici wrapper around the above
  /\bnetwork (?:error|disconnected)\b/i, // browsers / proxies
  /\bstream (?:closed|aborted) prematurely\b/i, // SSE drops
] as const

export function isAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: string }
  return e.name === 'AbortError' || e.code === 'ABORT_ERR'
}

function isTransientStreamError(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message : String(err)
  // Also peek at `cause` — undici wraps the real error in `cause` so
  // the outer message can be just "terminated" or "fetch failed".
  const causeMsg = (err as { cause?: unknown }).cause instanceof Error
    ? (err as { cause: Error }).cause.message
    : ''
  const combined = `${msg}\n${causeMsg}`
  return TRANSIENT_STREAM_ERROR_PATTERNS.some((p) => p.test(combined))
}

type StreamOpts = {
  system?: string
  tools?: ToolDef[]
  toolChoice?: ToolChoice
  signal: AbortSignal
  timeoutMs?: number
  model?: string
  temperature?: number
  maxTokens?: number
  onUsage: (u: LlmUsage) => void
  onPartialText?: (delta: string, totalSoFar: string) => void
}

/**
 * v1.2.112 — consume `provider.chatStream()` and synthesize a
 * ChatResult. The key win over `provider.chat()`: when the AbortSignal
 * fires mid-stream, we return the partial text + completed tool_calls
 * accumulated so far instead of an empty result. Tool_calls are
 * accumulated by `index`; entries that lack a `name` at abort time are
 * dropped (a partial tool_call is too risky to dispatch). Reasoning
 * trace (DeepSeek `reasoning_content`) is concatenated and passed
 * through so downstream UI can still render it.
 *
 * If the provider's stream impl produces no tool_call deltas but the
 * model wanted tool_use, the helper logs a warn and returns whatever
 * text + finishReason it saw. Caller (agent-loop) should treat
 * `finishReason='tool_use' with empty toolCalls` as a degenerate case
 * (rare; only happens when streaming is enabled against a provider
 * that hasn't extended its _callApiStream).
 */
export async function streamThenBuffer(
  provider: LlmProvider,
  history: LlmMessage[],
  opts: StreamOpts,
): Promise<ChatResult> {
  let text = ''
  let reasoning = ''
  let finishReason: FinishReason = 'unknown'
  let usage: LlmUsage = {}
  // tool_call accumulator: index → { id, name, argsConcat }
  const toolAcc = new Map<number, { id?: string; name?: string; argsConcat: string }>()
  // Complete tool calls delivered whole in a chunk (pseudo-streaming
  // providers, e.g. Anthropic's buffered `_callApiStream`). These win over
  // the delta accumulator since they're already fully formed.
  let completeToolCalls: ToolCallRequest[] | undefined

  try {
    for await (const chunk of provider.chatStream(history, {
      system: opts.system,
      tools: opts.tools,
      toolChoice: opts.toolChoice,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      model: opts.model,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      onUsage: opts.onUsage,
    })) {
      if (chunk.textDelta && chunk.textDelta.length > 0) {
        text += chunk.textDelta
        try { opts.onPartialText?.(chunk.textDelta, text) } catch { /* observer must not break stream */ }
      }
      if (chunk.reasoningDelta) {
        reasoning += chunk.reasoningDelta
      }
      if (chunk.toolCallDeltas && chunk.toolCallDeltas.length > 0) {
        for (const d of chunk.toolCallDeltas) {
          let acc = toolAcc.get(d.index)
          if (!acc) { acc = { id: undefined, name: undefined, argsConcat: '' }; toolAcc.set(d.index, acc) }
          if (d.id && !acc.id) acc.id = d.id
          if (d.name && !acc.name) acc.name = d.name
          if (d.argumentsDelta) acc.argsConcat += d.argumentsDelta
        }
      }
      // Complete tool calls delivered in one chunk (pseudo-streaming
      // providers). Accumulate across chunks in case a provider splits
      // them; last non-empty wins for a given turn.
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        completeToolCalls = [...(completeToolCalls ?? []), ...chunk.toolCalls]
      }
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.usage) usage = chunk.usage
    }
  } catch (err) {
    // Abort mid-stream is the headline case: don't re-throw — fall
    // through to synthesize a ChatResult with the partial accumulator.
    if (isAbort(err)) {
      finishReason = 'unknown' // caller will downgrade based on signal
    } else if (text.length > 0 || toolAcc.size > 0) {
      // v1.2.123 — non-abort throw with PARTIAL content (mid-stream
      // ECONNRESET, socket hang up, fetch failed, vendor closed the
      // SSE prematurely…). Don't drop the work — surface as
      // `length`-truncated so the agent-loop's existing length
      // recovery path (v1.2.117) continues the message from where the
      // connection dropped. If we had zero partial content, that's a
      // hard fail; fall through to the throw branch below.
      log.warn({
        event: 'agent-loop.stream_interrupted',
        err: err instanceof Error ? err.message : String(err),
        partialTextLen: text.length,
        partialToolCalls: toolAcc.size,
      }, 'streaming chat dropped mid-response; surfacing as length for recovery')
      finishReason = 'length'
    } else {
      // Zero partial content — no content to salvage, let the error
      // propagate so the caller's outer try/catch records an `error`
      // turn (and the IM user sees a real failure).
      throw err
    }
  }

  // Prefer complete tool calls delivered whole (pseudo-streaming providers)
  // over the delta accumulator; the latter stays empty for those providers.
  if (completeToolCalls && completeToolCalls.length > 0) {
    return {
      text,
      toolCalls: completeToolCalls,
      reasoningContent: reasoning || undefined,
      usage,
      finishReason,
      modelUsed: opts.model ?? provider.model,
    }
  }

  // Materialise accumulated tool_calls. Drop entries with no name (the
  // model didn't finish identifying which tool) — safer than guessing.
  const toolCalls: ToolCallRequest[] = []
  const indices = Array.from(toolAcc.keys()).sort((a, b) => a - b)
  for (const idx of indices) {
    const acc = toolAcc.get(idx)
    if (!acc) continue
    if (!acc.name) continue
    let args: Record<string, unknown> = {}
    if (acc.argsConcat) {
      try { args = JSON.parse(acc.argsConcat) as Record<string, unknown> }
      catch { args = { _raw: acc.argsConcat } }
    }
    toolCalls.push({
      id: acc.id ?? `stream-call-${idx}`,
      name: acc.name,
      arguments: args,
    })
  }

  return {
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    reasoningContent: reasoning || undefined,
    usage,
    finishReason,
    modelUsed: opts.model ?? provider.model,
  }
}

/** v1.2.138 — wrapper around streamThenBuffer that auto-retries on
 *  transient first-token errors. Existing caller invariants are
 *  preserved: success returns the ChatResult, abort propagates as-is,
 *  non-transient errors propagate as-is, exhausted retries throw the
 *  last error. Only retries when streamThenBuffer's outer error path
 *  fires AND the error matches a known transient pattern. The
 *  v1.2.123 "partial>0 → length recovery" path inside
 *  streamThenBuffer remains untouched — it returns a normal
 *  ChatResult that we forward without retry. */
export async function streamWithFirstTokenRetry(
  provider: LlmProvider,
  history: LlmMessage[],
  opts: StreamOpts,
): Promise<ChatResult> {
  const retryMax = resolveFirstTokenRetryMax()
  const retryDelayMs = resolveFirstTokenRetryDelayMs()
  let lastErr: unknown
  for (let attempt = 0; attempt <= retryMax; attempt++) {
    try {
      return await streamThenBuffer(provider, history, opts)
    } catch (err) {
      lastErr = err
      if (attempt >= retryMax) break
      if (isAbort(err)) break               // user cancellation — never retry
      if (!isTransientStreamError(err)) break // not our pattern — fail fast
      log.warn({
        event: 'agent-loop.first_token_retry',
        attempt: attempt + 1,
        cap: retryMax,
        backend: provider.name,
        err: err instanceof Error ? err.message : String(err),
        delayMs: retryDelayMs,
      }, 'transient stream error before first token; retrying')
      if (retryDelayMs > 0) await new Promise<void>((r) => setTimeout(r, retryDelayMs))
    }
  }
  throw lastErr
}
