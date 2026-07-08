// agent-loop — multi-iteration tool-using chat loop (Stage 2 sub-PR #3).
//
// One call to `runAgentLoop` is one *turn* from the IM user's perspective:
//
//                ┌──────────────────────────────────────────────────────┐
//                │ messages = [system?, user, ...history?]              │
//                │ tools    = []  (or [ToolDef, ToolDef, ...])           │
//                └────────────────────────┬─────────────────────────────┘
//                                         ▼
//             ┌───── iteration  i = 0 .. maxIterations-1 ───────┐
//             │                                                  │
//             │  provider.chat(messages, {tools})                │
//             │      ↓                                            │
//             │  finishReason ∈ {'stop','length','content_filter',│
//             │                  'tool_use','error','unknown'}    │
//             │                                                  │
//             │      ├─ tool_use → for each toolCall in result:  │
//             │      │     1. approvalGate(call) → allow|deny    │
//             │      │     2. dispatch(call) → DispatcherResult  │
//             │      │     3. append {role:'tool', toolCallId,    │
//             │      │              content:result.text}          │
//             │      │   then append the assistant turn (with    │
//             │      │   its toolCalls) BEFORE the tool messages │
//             │      │   so the provider can re-feed the batch.  │
//             │      │   continue.                                │
//             │      │                                            │
//             │      └─ anything else → return final text.       │
//             │                                                  │
//             └──────────────────────────────────────────────────┘
//
// Out-of-iteration paths:
//   - signal aborted   → return finishReason='aborted'
//   - max iterations   → return finishReason='max_iterations'
//   - provider throws  → return finishReason='error', text=''. We do
//                        NOT re-throw because callers (the upcoming
//                        native AgentAdapter) want to surface the
//                        error to the IM thread, not crash agim.
//
// Audit accounting: each iteration writes one `invocations` row with
// intent='native.agent.iter' and the iteration's usage. The agent loop
// itself is intentionally agnostic about the bigger "turn" — the caller
// (sub-PR #4 AgentAdapter) will write a parent invocation row that
// aggregates these. Per-iteration rows make `/tasks#cost` pivots
// possible (you can see whether 90% of cost went into one runaway
// iteration vs spread evenly).

import { logger as rootLogger } from '../logger.js'
import { logInvocation } from '../audit-log.js'
import type {
  ChatResult,
  FinishReason,
  LlmMessage,
  LlmProvider,
  LlmUsage,
  ToolCallRequest,
  ToolChoice,
  ToolDef,
} from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { runGoalCritic, resolveCriticMode } from './goal-critic.js'
import { detectHallucinatedToolCall, isHallucinationDetectorOn } from './hallucination-detector.js'
import { validateAgainstSchema, formatValidationErrors } from './schema-validate.js'
import {
  stableStringify as _stableStringify,
  extractErrorType as _extractErrorType,
  isStuckLoop as _isStuckLoop,
  isSemanticStuckLoop as _isSemanticStuckLoop,
  extractSalientStrings as _extractSalientStrings,
  resolveEnvBool as _resolveEnvBool,
  resolveEnvInt as _resolveEnvInt,
} from './loop-guards.js'

const log = rootLogger.child({ component: 'agent-loop' })

const DEFAULT_MAX_ITERATIONS = 20
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000  // 5 min — generous; signal usually fires first

// v1.2.98 — goal-critic firing schedule. Thresholds chosen empirically:
// fewer than 5 tool calls = not enough trail to judge; more often than
// every 5 tool calls = critic itself becomes too noisy. Per-turn cap
// of 2 keeps a runaway critic from compounding cost on a hot turn.
const CRITIC_MIN_TOOL_CALLS = 5
const CRITIC_EVERY_N = 5
const CRITIC_MAX_CALLS = 2

// ─── env-based config (thin wrappers; callers hoist to turn scope) ───

function truncateToolResult(text: string, cap: number, toolName: string): { text: string; truncated: boolean } {
  if (cap === 0 || text.length <= cap) return { text, truncated: false }
  const dropped = text.length - cap
  const marker = `\n\n…[${toolName} output truncated: ${dropped} of ${text.length} chars omitted; set AGIM_NATIVE_TOOL_RESULT_MAX_CHARS to raise the cap]`
  return { text: text.slice(0, cap) + marker, truncated: true }
}

function resolveToolTimeoutMs(perToolMs: number | undefined, defaultMs: number): number {
  if (typeof perToolMs === 'number' && perToolMs >= 0) return perToolMs
  return defaultMs
}

/** Snapshot all env-driven knobs once per runAgentLoop invocation so
 *  the hot per-tool-call path never re-reads process.env. */
interface LoopEnvConfig {
  schemaValidateOn: boolean
  streamEnabled: boolean
  lengthRecoveryMax: number
  toolResultMaxChars: number
  defaultToolTimeoutMs: number
  blankRetryMax: number
  semanticStuckLoopOn: boolean
  firstTokenRetryMax: number
  firstTokenRetryDelayMs: number
}
function snapshotEnvConfig(): LoopEnvConfig {
  return {
    schemaValidateOn: _resolveEnvBool('AGIM_TOOL_SCHEMA_VALIDATE', true),
    streamEnabled: _resolveEnvBool('AGIM_AGENT_LOOP_STREAM', true),
    lengthRecoveryMax: _resolveEnvInt('AGIM_NATIVE_LENGTH_RECOVERY_MAX', 3, { max: 10 }),
    toolResultMaxChars: _resolveEnvInt('AGIM_NATIVE_TOOL_RESULT_MAX_CHARS', 32_768),
    defaultToolTimeoutMs: _resolveEnvInt('AGIM_NATIVE_TOOL_TIMEOUT_MS', 60_000),
    blankRetryMax: _resolveEnvInt('AGIM_NATIVE_BLANK_RETRY_MAX', 2, { max: 5 }),
    semanticStuckLoopOn: _resolveEnvBool('AGIM_NATIVE_SEMANTIC_STUCK_LOOP', true),
    firstTokenRetryMax: _resolveEnvInt('AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX', 1, { max: 3 }),
    firstTokenRetryDelayMs: _resolveEnvInt('AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS', 1000, { max: 10000 }),
  }
}

/** Synthetic user nudge for the blank-response branch. Short + explicit
 *  so the model gets that it produced nothing the user can see. */
const BLANK_RESPONSE_NUDGE =
  'Your last response was empty (no text and no tool call). ' +
  'Please continue: either call a tool to make progress, or produce ' +
  'a complete answer to the user. If you have already completed the ' +
  'task, write the closing summary now.'

/** v1.2.117 — synthetic user message we inject after a `length` truncation.
 *  Kept short (cache-friendly) and explicit ("don't repeat") so the model
 *  picks up exactly where it stopped rather than re-summarising. */
const LENGTH_RECOVERY_MESSAGE =
  'Your previous response was cut off due to the output length limit. ' +
  'Continue from exactly where you left off — do not repeat any content ' +
  'and do not start over. If you were inside a markdown list, table, or ' +
  'code block, continue inside it; if you were mid-sentence, complete it.'

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
async function streamThenBuffer(
  provider: LlmProvider,
  history: LlmMessage[],
  opts: {
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
  },
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
    const acc = toolAcc.get(idx)!
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

function isAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: string }
  return e.name === 'AbortError' || e.code === 'ABORT_ERR'
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
async function streamWithFirstTokenRetry(
  provider: LlmProvider,
  history: LlmMessage[],
  opts: {
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
  },
): Promise<ChatResult> {
  const retryMax = _resolveEnvInt('AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX', 1, { max: 3 })
  const retryDelayMs = _resolveEnvInt('AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS', 1000, { max: 10000 })
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

// Re-export guard primitives from loop-guards for backward compat.
export const stableStringify = _stableStringify
export const extractErrorType = _extractErrorType
export const isStuckLoop = _isStuckLoop

export const isSemanticStuckLoop = _isSemanticStuckLoop
export const extractSalientStrings = _extractSalientStrings

type MaybePromise<T> = T | Promise<T>

/**
 * Per-tool-call gate. Return 'allow' to dispatch, 'deny' to inject a
 * "user denied" tool result (so the model can react) without running
 * the tool. Sub-PR #4 ships an IM-integrated implementation; tests
 * and intro use a no-op gate (alwaysAllowGate).
 *
 * `call` is the request the LLM produced; `attempt` is the 0-indexed
 * iteration count, useful for "ask once per session" policies.
 */
export type ApprovalGate = (
  call: ToolCallRequest,
  attempt: number,
) => Promise<'allow' | 'deny'>

/** Default: skip approval entirely. The agent loop is safe-by-default
 *  for tests and the introspection use case; production AgentAdapters
 *  should pass a real gate. */
export const alwaysAllowGate: ApprovalGate = async () => 'allow'

export type ToolPolicyDecision =
  | 'allow'
  | 'deny'
  | { decision: 'allow' | 'deny'; reason?: string }

export interface AgentToolPolicyContext {
  call: ToolCallRequest
  attempt: number
  history: readonly LlmMessage[]
  toolCalls: readonly ToolCallReport[]
  traceId?: string
  platform?: string
  userId?: string
}

/**
 * Policy layer inspired by PI's env/per-run tool policy hooks, but kept
 * Agim-native. `canRunTool` is a fast allow/deny guard before any HITL
 * approval prompt. `approveToolRun` can replace the legacy `approve`
 * callback for callers that want a richer per-run approval object.
 */
export interface AgentToolPolicy {
  canRunTool?: (ctx: AgentToolPolicyContext) => MaybePromise<ToolPolicyDecision | undefined>
  approveToolRun?: (ctx: AgentToolPolicyContext) => MaybePromise<ToolPolicyDecision>
}

/** Auxiliary finish reasons the agent loop adds on top of the provider's
 *  finishReason vocabulary.
 *
 *  - `stuck_loop` (v1.2.95): the loop terminated early because the model
 *    called the SAME tool with the SAME outcome (error+preview hash)
 *    three iterations in a row — usually means it's stuck re-trying a
 *    failing SQL / fetch / command without changing strategy. Without
 *    this break a stuck model would burn the full
 *    AGIM_NATIVE_AGENT_MAX_ITER budget; stopping early saves cost AND
 *    gives the user a much more actionable recap. */
/**  - `off_track` (v1.2.98): goal-critic flagged the recent tool chain
 *    as semantically off-target for the user's prompt / active goal.
 *    Different from stuck_loop (mechanical repeat) — this catches the
 *    "different calls but still pointless" failure mode. */
export type LoopFinishReason = FinishReason | 'max_iterations' | 'aborted' | 'stuck_loop' | 'off_track' | 'hallucinated_tools'

export interface AgentLoopPrepareNextTurnContext {
  iter: number
  history: readonly LlmMessage[]
  toolCalls: readonly ToolCallReport[]
  usage: Readonly<LlmUsage>
  providerName: string
  signal: AbortSignal
}

export interface AgentLoopStopAfterTurnContext extends AgentLoopPrepareNextTurnContext {
  result: Readonly<ChatResult>
  toolsEnabled: boolean
  lengthRecoveryPrefix: string
}

export interface AgentLoopStopDecision {
  finishReason: LoopFinishReason
  text?: string
  error?: string
}

/**
 * Turn-level policy hooks. These are deliberately small: policies may
 * inject messages before the next model call, or stop after a model
 * turn. They do not replace Agim's built-in recovery/stuck-loop logic;
 * they give future reliability behaviours a composable place to live.
 */
export interface AgentLoopPolicy {
  prepareNextTurn?: (
    ctx: AgentLoopPrepareNextTurnContext,
  ) => MaybePromise<LlmMessage | LlmMessage[] | undefined>
  shouldStopAfterTurn?: (
    ctx: AgentLoopStopAfterTurnContext,
  ) => MaybePromise<AgentLoopStopDecision | undefined>
}

export interface AgentLoopInput {
  provider: LlmProvider
  /** Optional system prompt prepended ONCE; never re-issued across
   *  iterations. If `messages[0]` is already a system message, this
   *  field is ignored (mirrors LlmProvider.chat semantics). */
  systemPrompt?: string
  /** Conversation so far. The loop appends to a local copy; the caller's
   *  array is NOT mutated. */
  messages: LlmMessage[]
  /** Tools the LLM may call. Empty / undefined disables tool use even
   *  if the provider advertises it. */
  tools?: ToolDef[]
  /** Hint forwarded to provider.chat (see provider-base ToolChoice). */
  toolChoice?: ToolChoice

  /** Hard cap on iterations. Default 20 — high enough for non-trivial
   *  research, low enough that a runaway loop is bounded. */
  maxIterations?: number
  /** Hard wall-clock cap (ms). Default 5 min. */
  timeoutMs?: number
  /** Outer abort signal; merged with timeoutMs into the provider call. */
  signal?: AbortSignal
  /** Per-call provider knobs (model override / temperature / etc.). */
  callOptions?: { model?: string; temperature?: number; maxTokens?: number }

  /** Routes tool calls to executors. Required when `tools` is non-empty;
   *  the loop throws on missing dispatcher to surface misconfig early. */
  dispatch?: ToolDispatcher
  /** Pre-tool gate. Defaults to alwaysAllowGate. */
  approve?: ApprovalGate

  /** Agim-native per-run/env tool policy. Runs before the legacy
   *  approval gate and can also supply a richer approval hook. */
  toolPolicy?: AgentToolPolicy

  /** Optional turn policies, used for future loop steering/reliability
   *  without wrapping or post-processing the final answer. */
  loopPolicy?: AgentLoopPolicy | readonly AgentLoopPolicy[]

  /** Audit context — written into per-iteration invocations rows. The
   *  agent name should distinguish native vs cli (e.g. 'llm:native-chat'). */
  audit?: {
    agent: string
    intent?: string
    userId?: string
    platform?: string
    traceId?: string
  }

  /** v1.2.86 — when set, the loop checks goals.db for an active goal on
   *  this thread and extends the wall timeout (default 3×, cap 6 h).
   *  Supplied by AgentAdapter / cli.ts when invoking the native agent
   *  from a real IM run; tests typically leave it undefined and get the
   *  un-boosted timeout. */
  goalCtx?: {
    platform: string
    channelId: string
    threadId: string
  }

  /** v1.2.98 — anchors handed to the goal-critic when it fires.
   *  `prompt` is the user's current-turn input string; `goalTitle` +
   *  `goalBody` come from goals.getActiveGoal for this thread (caller
   *  fetches once; loop just relays). Either may be empty — critic
   *  refuses to judge if both are. Leaving criticAnchor unset (or
   *  setting AGIM_NATIVE_CRITIC=off) disables the critic for this
   *  invocation. */
  criticAnchor?: {
    prompt?: string
    goalTitle?: string
    goalBody?: string
  }

  /** v1.2.109 — names of tools the caller declares parallel-safe (no
   *  shared state, no side effects, order-independent). When the model
   *  returns multiple tool_calls in one iteration, declared-safe calls
   *  run concurrently via Promise.allSettled; everything else (and any
   *  tool not in this set) keeps the legacy serial behaviour, with a
   *  barrier drain before each serial dispatch so serial calls observe
   *  a settled world. Emission order to history + toolCalls is always
   *  the original call order (tool_call_id ↔ tool_result alignment).
   *  Leave undefined → loop is fully serial (no behaviour change vs
   *  v1.2.108). */
  parallelSafeTools?: ReadonlySet<string>

  /** T2 — per-call concurrency classifier. Takes precedence over
   *  `parallelSafeTools` when provided. Returns true ONLY for genuinely
   *  read-only / pure / order-independent calls; the loop falls back to
   *  serial for everything else. Fail-closed: a classifier that throws is
   *  treated as "not safe" (serial), never escalated to a crash. Lets a
   *  source classify the SAME tool name differently per input (e.g. a glob
   *  that triggers a write) — the static set can't. */
  parallelSafeClassifier?: (call: ToolCallRequest) => boolean

  /** v1.2.112 — opt into streaming the provider response so the iter
   *  preserves partial assistant text on abort instead of dropping
   *  everything when the 30-min IM hard timeout fires mid-response.
   *  When true the loop uses `provider.chatStream()`, accumulates text
   *  / tool_calls / reasoning, and on abort returns the partial text
   *  with finishReason='aborted'. Falls back to buffered `chat()` on
   *  any provider that doesn't implement streaming. Default false to
   *  preserve v1.2.111 behaviour. Env `AGIM_AGENT_LOOP_STREAM=off`
   *  is a process-wide kill switch even when this is true (so ops can
   *  flip it off without code changes). */
  streamPartialText?: boolean

  /** v1.2.112 — fires with each streamed text delta (after backpressure-
   *  free accumulation). Useful for "agent is thinking… 100/250/...
   *  chars produced" heartbeats or future SSE push to the IM client.
   *  Only fires when `streamPartialText` is effectively true. */
  onPartialText?: (delta: string, totalSoFar: string) => void

  /** Lifecycle hooks for caller-side observability (heartbeats, progress
   *  push, custom logging). All hooks are best-effort: thrown errors are
   *  swallowed so a faulty observer cannot break the loop. */
  hooks?: {
    /** Fires right before a tool's dispatcher is invoked (after the
     *  approval gate has allowed the call). */
    onToolStart?: (call: ToolCallRequest) => void
    /** Fires right after the dispatcher returns or throws. */
    onToolEnd?: (call: ToolCallRequest, summary: { isError: boolean; durationMs: number }) => void
  }
}

export interface ToolCallReport {
  name: string
  /** `'allow' | 'deny'` from the approval gate before dispatch. */
  decision: 'allow' | 'deny'
  /** True iff the dispatcher reported an error (or denied). */
  isError: boolean
  /** Tag from the dispatcher (e.g. 'mcp:filesystem' / 'unknown'). */
  source: string
  durationMs: number
  /** First 200 chars of the tool result text. Useful for debug /
   *  `/heartbeat run-now` style introspection; longer payloads aren't
   *  retained to keep memory + log size bounded. */
  preview: string
  /** v1.2.108 — stable JSON of the tool call's arguments (sorted keys),
   *  used by the stuck-loop detector. Identical calls hash to identical
   *  strings; model varying timestamps/UUIDs in the result no longer
   *  hides a stuck loop where the model keeps re-calling with the same
   *  args. See `stableStringify`. */
  argsKey: string
  /** v1.2.108 — short fingerprint of the error (first non-empty line of
   *  the result, ≤80 chars) when isError; empty string otherwise. Lets
   *  the stuck-loop detector distinguish "same failure repeated" from
   *  "same args returning different bytes". See `extractErrorType`. */
  errorType: string
}

export interface AgentLoopResult {
  /** Final assistant text the caller should show the user. May be the
   *  empty string for finishReason='max_iterations' / 'aborted' if the
   *  model never emitted assistant text before being cut off. */
  text: string
  /** Number of provider.chat() calls (0 only when input.messages is
   *  empty AND the loop never ran). */
  iterations: number
  /** Reports for every tool call the loop dispatched (or denied). */
  toolCalls: ToolCallReport[]
  /** Aggregated usage across iterations. costUsd is summed when present. */
  usage: LlmUsage
  /** Why the loop stopped. */
  finishReason: LoopFinishReason
  /** Provider-side error message when finishReason='error'. */
  error?: string
}

/**
 * Run the loop. ALL exceptions are caught and converted to a result
 * with finishReason='error' — the caller (IM AgentAdapter) wants to
 * surface failures to the user, not crash agim.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const tools = input.tools && input.tools.length > 0 ? input.tools : undefined
  if (tools && !input.dispatch) {
    throw new Error('agent-loop: dispatch is required when tools is non-empty')
  }
  const maxIter = clampInt(input.maxIterations ?? DEFAULT_MAX_ITERATIONS, 1, 100)
  // v1.2.86 — when this thread has an active long-task goal, multiply
  // the wall timeout (default 3×, capped at 6 h). Goals signal "I
  // expect this turn to be a research/coding marathon" — without this
  // boost, 5 min was the silent kill point.
  const baseTimeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { applyGoalTimeoutBoost } = await import('../goals.js')
  const timeoutMs = applyGoalTimeoutBoost(baseTimeout, input.goalCtx)
  const approve = input.approve ?? alwaysAllowGate
  const dispatch = input.dispatch
  const signal = mergeSignal(input.signal, timeoutMs)
  const loopPolicies = normalizeLoopPolicies(input.loopPolicy)

  // Snapshot env-driven knobs once per turn (not per tool call).
  const envCfg = snapshotEnvConfig()

  // Build name→schema and name→ToolDef maps once for O(1) lookups
  // during per-tool-call processing (schema validation + timeout).
  const schemaByName = new Map<string, unknown>(
    (tools ?? []).map((t) => [t.name, t.parameters]),
  )
  const toolDefByName = new Map<string, ToolDef>(
    (tools ?? []).map((t) => [t.name, t]),
  )

  const streamEnabled = !!input.streamPartialText && envCfg.streamEnabled

  // Local copy so we don't mutate the caller's array.
  const history: LlmMessage[] = input.messages.slice()
  const toolCalls: ToolCallReport[] = []
  const usageAcc: LlmUsage = {}
  // v1.2.98 — goal-critic per-turn fire counter (capped at CRITIC_MAX_CALLS).
  let criticCallsFired = 0
  // v1.2.109 — throttle for the post-batch critic check. With parallel
  // batching, toolCalls.length now jumps in chunks instead of advancing
  // by 1 per per-call modulo check. Track the last fire to keep at-most-
  // every-CRITIC_EVERY_N cadence regardless of batch size.
  let lastCriticAtToolCalls = 0
  // v1.2.117 — length-recovery counter + accumulated prefix.
  // Each `finishReason === 'length'` we observe pushes the partial
  // assistant text onto `lengthRecoveryPrefix` so the final return
  // value is the WHOLE message (partial1 + partial2 + … + final).
  // Without this the caller would only see the last continuation
  // chunk, not the long-form answer they were actually waiting on.
  let lengthRecoveryCount = 0
  const lengthRecoveryMax = envCfg.lengthRecoveryMax
  let lengthRecoveryPrefix = ''
  // v1.2.119 — intra-loop blank-response retry counter. Independent
  // from length-recovery (which fires when text *is* present but cut);
  // this fires when text + tool_calls are BOTH empty mid-loop.
  let blankRetryCount = 0
  const blankRetryMax = envCfg.blankRetryMax

  let iter = 0
  for (; iter < maxIter; iter++) {
    if (signal.signal.aborted) {
      signal.cleanup()
      return {
        // v1.2.117 — if we accumulated partial text via length-recovery
        // before being aborted, surface it; otherwise empty as before.
        text: lengthRecoveryPrefix,
        iterations: iter,
        toolCalls,
        usage: usageAcc,
        finishReason: 'aborted',
      }
    }

    const prepared = await prepareNextTurn(loopPolicies, {
      iter,
      history: history.slice(),
      toolCalls: toolCalls.slice(),
      usage: { ...usageAcc },
      providerName: input.provider.name,
      signal: signal.signal,
    })
    if (prepared.length > 0) history.push(...prepared)

    let result: ChatResult
    const t0 = Date.now()
    try {
      if (streamEnabled) {
        // v1.2.112 — accumulate via stream so abort mid-response keeps
        // the partial text + completed tool_calls instead of dropping
        // everything. See `streamThenBuffer` for the contract.
        //
        // v1.2.138 — retry once (configurable) when streamThenBuffer
        // throws a transient network error BEFORE any token landed.
        // Undici "terminated" / ECONNRESET / "fetch failed" on first-
        // byte are the common patterns; a single 1s-backed retry
        // recovers most of them without burning meaningful budget.
        // streamThenBuffer already salvages the >0 partial case as
        // `finishReason='length'` — the retry only applies when
        // partial was zero (no salvage possible).
        result = await streamWithFirstTokenRetry(input.provider, history, {
          system: input.systemPrompt,
          tools,
          toolChoice: input.toolChoice,
          signal: signal.signal,
          timeoutMs,
          model: input.callOptions?.model,
          temperature: input.callOptions?.temperature,
          maxTokens: input.callOptions?.maxTokens,
          onUsage: (u) => mergeUsage(usageAcc, u),
          onPartialText: input.onPartialText,
        })
        // v1.2.112 — stream was aborted mid-flight. The headline win
        // of this whole batch is: don't drop what the model already
        // produced. Short-circuit here with `aborted` + the accumulated
        // partial text so the caller (native adapter) can show it.
        // streamThenBuffer caught the AbortError and returned with
        // whatever it had; we just need to flag it as aborted on the
        // AgentLoopResult (ChatResult.finishReason can't carry it).
        if (signal.signal.aborted) {
          signal.cleanup()
          return {
            // v1.2.117 — concatenate accumulated partials with the
            // current iteration's partial text.
            text: lengthRecoveryPrefix + result.text,
            iterations: iter + 1,
            toolCalls,
            usage: usageAcc,
            finishReason: 'aborted',
          }
        }
      } else {
        result = await input.provider.chat(history, {
          system: input.systemPrompt,
          tools,
          toolChoice: input.toolChoice,
          signal: signal.signal,
          timeoutMs,
          model: input.callOptions?.model,
          temperature: input.callOptions?.temperature,
          maxTokens: input.callOptions?.maxTokens,
          onUsage: (u) => mergeUsage(usageAcc, u),
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({
        event: 'agent-loop.provider_failed',
        backend: input.provider.name,
        iter, err: msg,
      })
      signal.cleanup()
      writeIterAudit(input.audit, t0, 0, 0, false, msg)
      return {
        // v1.2.117 — preserve accumulated partials even on provider error.
        text: lengthRecoveryPrefix,
        iterations: iter + 1,
        toolCalls,
        usage: usageAcc,
        finishReason: 'error',
        error: msg,
      }
    }

    writeIterAudit(
      input.audit, t0,
      // prompt_len approx = sum of message lengths; cheap to compute.
      history.reduce((n, m) => n + (m.content?.length ?? 0), 0),
      result.text.length,
      true,
      undefined,
      result.usage.costUsd,
    )

    const stopDecision = await shouldStopAfterTurn(loopPolicies, {
      iter,
      history: history.slice(),
      toolCalls: toolCalls.slice(),
      usage: { ...usageAcc },
      providerName: input.provider.name,
      signal: signal.signal,
      result,
      toolsEnabled: !!tools?.length,
      lengthRecoveryPrefix,
    })
    if (stopDecision) {
      signal.cleanup()
      return {
        text: stopDecision.text ?? (lengthRecoveryPrefix + result.text),
        iterations: iter + 1,
        toolCalls,
        usage: usageAcc,
        finishReason: stopDecision.finishReason,
        error: stopDecision.error,
      }
    }

    // v1.2.117 — auto-continue on length truncation.
    // OpenAI-style `finish_reason: 'length'` means the model hit
    // max_tokens mid-response. Pre-fix the loop just returned the
    // partial text and the user saw an unfinished markdown / sentence
    // / table. Strategy (mirrors HKUDS/nanobot/agent/runner.py):
    //   (1) Push the partial assistant turn into history AS-IS — the
    //       model already paid the tokens, don't discard.
    //   (2) Drop any partial tool_calls on this turn: a half-emitted
    //       JSON args object is dangerous to dispatch (obot doc'd
    //       $0.91 burned on dispatching a truncated tool call). The
    //       continuation prompt asks the model to redo any tool call
    //       cleanly if it still needs one.
    //   (3) Append a synthetic user-role message instructing the
    //       model to continue from where it stopped without repeating.
    //   (4) Increment the per-turn counter; bail if we've hit the cap
    //       to prevent runaway retries.
    if (
      result.finishReason === 'length'
      && lengthRecoveryCount < lengthRecoveryMax
    ) {
      lengthRecoveryCount += 1
      log.info({
        event: 'agent-loop.length_recovery',
        attempt: lengthRecoveryCount,
        cap: lengthRecoveryMax,
        partialTextLen: result.text.length,
        droppedToolCalls: result.toolCalls?.length ?? 0,
        backend: input.provider.name,
        iter,
      }, 'LLM output cut off (max_tokens); auto-continuing without repeat')
      // (1) Preserve partial assistant content in history (so the next
      // chat() call sees what was said), AND accumulate it into the
      // prefix used to assemble the final return text. Otherwise the
      // caller would only get the last continuation chunk.
      //
      // v1.2.132 — skip the push entirely when partial is empty.
      // Otherwise we'd ship `{ role: 'assistant', content: '' }` with
      // no tool_calls, which OpenAI Chat Completions (and DeepSeek)
      // reject with the same HTTP 400 "Invalid assistant message"
      // that v1.2.130 caught for the blank-retry path. This happens
      // most often on a TCP drop BEFORE the first token landed
      // (v1.2.123 graceful-degradation path classifies that as
      // `finishReason: 'length'` with partialTextLen=0).
      lengthRecoveryPrefix += result.text
      if (result.text) {
        history.push({
          role: 'assistant',
          content: result.text,
          reasoningContent: result.reasoningContent,
        })
      }
      // (2) Drop tool_calls even if present — re-executing a half-
      // emitted JSON args object is the obot-platform $0.91 disaster
      // ([HKUDS/nanobot#2318]). The continuation prompt lets the
      // model re-issue the call cleanly if it still needs to.
      // (3) Recovery prompt.
      history.push({ role: 'user', content: LENGTH_RECOVERY_MESSAGE })
      // Don't bump `iter` past maxIter prematurely — the for-loop will
      // increment normally. Just keep going.
      continue
    }

    // v1.2.119 — blank-response retry.
    //
    // Trigger: model returned `finishReason: 'stop'` with empty text
    // AND no tool_calls — i.e. the iteration produced nothing the
    // caller can use. This is a transient model glitch (especially
    // common on the first iteration with some Chinese-tuned LLMs and
    // after long context conditioning); a single nudge usually
    // recovers. We retry up to blankRetryMax times before falling
    // through to early-terminate (where the v1.2.91 recap kicks in).
    //
    // We do NOT trigger this when there ARE tool calls but text is
    // empty — that's a separate case handled by the v1.2.94 POST-loop
    // auto-summary retry at the native-adapter layer.
    if (
      blankRetryCount < blankRetryMax
      && (result.finishReason === 'stop' || result.finishReason === 'unknown')
      && !result.text
      && (!result.toolCalls || result.toolCalls.length === 0)
    ) {
      blankRetryCount += 1
      log.info({
        event: 'agent-loop.blank_retry',
        attempt: blankRetryCount,
        cap: blankRetryMax,
        backend: input.provider.name,
        iter,
      }, 'provider returned empty text + no tool_calls; nudging once more')
      // v1.2.130 — DON'T persist the empty assistant turn. OpenAI Chat
      // Completions and strict openai-compat providers (DeepSeek
      // included) reject any assistant message whose `content` is empty
      // AND has no `tool_calls`. Pushing the placeholder was a v1.2.119
      // oversight: it made the very next API call 400 with "Invalid
      // assistant message: content or tool_calls must be set" whenever
      // the retry actually fired. Two consecutive user messages (the
      // original prompt + the nudge) is fine for openai-compat — the
      // spec does not require strict alternation.
      history.push({ role: 'user', content: BLANK_RESPONSE_NUDGE })
      continue
    }

    // No tools, or model decided not to call any → terminate.
    if (result.finishReason !== 'tool_use' || !result.toolCalls || result.toolCalls.length === 0) {
      // v1.2.147 — hallucinated tool-call detector. When the model
      // talks about invoking a native_* tool ("我现在调用 native_write_file:
      // ```python …```") but never emitted the toolCalls schema entry,
      // we'd otherwise ship the lie as a normal reply. Flag it so the
      // adapter renders a targeted recap instead.
      //
      // Scope: only finishReason==='stop' (model thinks it's done), with
      // non-empty text and zero real tool calls. Skips when tools array
      // is undefined (turn had no tool surface) since "narrate without
      // emit" makes no sense without a surface to emit against.
      if (
        result.finishReason === 'stop'
        && result.text
        && (!result.toolCalls || result.toolCalls.length === 0)
        && tools && tools.length > 0
        && isHallucinationDetectorOn()
      ) {
        const det = detectHallucinatedToolCall({
          text: result.text,
          toolNames: tools.map((t) => t.name),
          emittedToolCallCount: 0,
        })
        if (det.hallucinated) {
          log.warn({
            event: 'agent-loop.hallucinated_tool_call',
            pattern: det.pattern,
            evidence: det.evidence,
            backend: input.provider.name,
            iter,
          }, 'model narrated a tool call without emitting toolCalls — flagging recap')
          signal.cleanup()
          return {
            text: lengthRecoveryPrefix + result.text,
            iterations: iter + 1,
            toolCalls,
            usage: usageAcc,
            finishReason: 'hallucinated_tools',
          }
        }
      }
      signal.cleanup()
      return {
        // v1.2.117 — prefix accumulated partials so a chain of length
        // truncations returns the concatenated full message.
        text: lengthRecoveryPrefix + result.text,
        iterations: iter + 1,
        toolCalls,
        usage: usageAcc,
        finishReason: result.finishReason,
      }
    }

    // Persist the assistant turn with its toolCalls so the next
    // provider call sees the same conversation shape.
    history.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
      reasoningContent: result.reasoningContent,
    })

    // v1.2.109 — execute tool calls with optional parallel batching.
    // Tools whose names appear in input.parallelSafeTools dispatch via
    // accumulating promises (Promise.allSettled); everything else (and
    // any tool not declared safe) keeps the legacy serial path with a
    // barrier drain before each serial dispatch so serial calls observe
    // a settled world (MCP session state, file system, etc.).
    // Emission order to history / toolCalls is always the original call
    // order via slot arrays — some providers reject responses whose
    // role:'tool' messages aren't laid out next to their assistant
    // tool_calls in the expected order.
    const parallelSafe = input.parallelSafeTools
    const historySlots: Array<LlmMessage | null> = new Array(result.toolCalls.length).fill(null)
    const reportSlots: Array<ToolCallReport | null> = new Array(result.toolCalls.length).fill(null)
    const pendingTasks: Promise<void>[] = []

    for (let idx = 0; idx < result.toolCalls.length; idx++) {
      if (signal.signal.aborted) break
      const call = result.toolCalls[idx]!

      // Stable arg key precomputed once per call so all three slot
      // writers (deny / no-dispatcher / dispatched) share the same
      // identity for the stuck-loop detector.
      const argsKey = stableStringify(call.arguments)
      const reportBase = {
        name: call.name,
        source: 'unknown',
        preview: '',
        argsKey,
        errorType: '',
      }

      // Approval/policy is ALWAYS serial — it may block on user input,
      // and asking for N approvals at once would spam the IM UI.
      const decision = await decideToolAccess(input.toolPolicy, approve, {
        call,
        attempt: iter,
        history: history.slice(),
        toolCalls: toolCalls.slice(),
        traceId: input.audit?.traceId,
        platform: input.audit?.platform,
        userId: input.audit?.userId,
      })
      if (decision.decision === 'deny') {
        const reason = decision.reason ? `: ${decision.reason}` : ''
        const denyText = decision.source === 'policy'
          ? `tool call denied by policy: ${call.name}${reason}`
          : `tool call denied by user: ${call.name}${reason}`
        historySlots[idx] = { role: 'tool', toolCallId: call.id, content: denyText }
        reportSlots[idx] = {
          ...reportBase,
          decision: 'deny',
          isError: true,
          durationMs: 0,
          preview: denyText,
          errorType: extractErrorType(true, denyText),
        }
        continue
      }

      if (!dispatch) {
        // Defensive — schema enforces dispatch when tools is set, but
        // theoretically a caller could pass tools+approve without a
        // dispatcher. Don't crash; tell the model the tool failed.
        const denyText = `tool call refused: no dispatcher registered`
        historySlots[idx] = { role: 'tool', toolCallId: call.id, content: denyText }
        reportSlots[idx] = {
          ...reportBase,
          decision: 'allow',
          isError: true,
          durationMs: 0,
          preview: denyText,
          errorType: extractErrorType(true, denyText),
        }
        continue
      }

      // v1.2.110 — pre-dispatch JSON-Schema validation. Catches "model
      // sent the wrong shape" (missing required field, string-where-int,
      // bad enum, etc.) and feeds the model a structured "fix and retry"
      // message INSTEAD of dispatching with garbage args. Without this,
      // the dispatcher had to defensively parse / coerce, and any
      // failure surfaced as an opaque "tool threw: …" the model rarely
      // self-corrected. Disabled when AGIM_TOOL_SCHEMA_VALIDATE=off.
      const toolSchema = schemaByName.get(call.name)
      if (envCfg.schemaValidateOn && toolSchema) {
        const verrs = validateAgainstSchema(call.arguments, toolSchema)
        if (verrs.length > 0) {
          const msg = formatValidationErrors(call.name, verrs)
          historySlots[idx] = { role: 'tool', toolCallId: call.id, content: msg }
          reportSlots[idx] = {
            ...reportBase,
            decision: 'allow',
            isError: true,
            durationMs: 0,
            source: 'schema-validation',
            preview: msg.slice(0, 200),
            errorType: extractErrorType(true, msg),
          }
          log.debug({
            event: 'agent-loop.schema_validation_failed',
            tool: call.name,
            errors: verrs.length,
            firstError: verrs[0],
          })
          continue
        }
      }

      // Capture dispatch into an async closure so it can be awaited
      // either immediately (serial path) or later via Promise.allSettled
      // (parallel batch path). Captures idx by closure so the writer
      // hits the correct slot regardless of completion order.
      const dispatchCall = dispatch
      // v1.2.111 — thread the parent trace id to dispatchers (notably
      // agim-dispatcher's A2A path) so the whole turn shares one
      // trace prefix instead of each fan-out minting a fresh root.
      const dispatchCtx = { traceId: input.audit?.traceId }
      const toolDef = toolDefByName.get(call.name)
      const perToolTimeoutMs = resolveToolTimeoutMs(toolDef?.timeoutMs, envCfg.defaultToolTimeoutMs)
      const runDispatch = async (): Promise<void> => {
        try { input.hooks?.onToolStart?.(call) } catch { /* observer must not break loop */ }
        const t0 = Date.now()
        let dispatched: DispatcherResult
        try {
          dispatched = await dispatchWithTimeout(
            (sig) => dispatchCall(call, sig, dispatchCtx),
            signal.signal,
            perToolTimeoutMs,
            call.name,
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          dispatched = { text: `tool threw: ${msg}`, isError: true, source: 'error' }
          log.warn({
            event: 'agent-loop.dispatch_threw',
            tool: call.name, err: msg,
          })
        }
        const durationMs = Date.now() - t0
        // v1.2.118 — apply per-tool-result byte cap so one chatty tool
        // can't poison the rest of the turn's context window.
        const truncated = truncateToolResult(dispatched.text, envCfg.toolResultMaxChars, call.name)
        if (truncated.truncated) {
          log.info({
            event: 'agent-loop.tool_result_truncated',
            tool: call.name,
            originalLen: dispatched.text.length,
            capped: envCfg.toolResultMaxChars,
          })
        }
        try { input.hooks?.onToolEnd?.(call, { isError: !!dispatched.isError, durationMs }) } catch { /* observer must not break loop */ }
        historySlots[idx] = {
          role: 'tool',
          toolCallId: call.id,
          content: truncated.text,
        }
        reportSlots[idx] = {
          name: call.name,
          decision: 'allow',
          isError: dispatched.isError,
          source: dispatched.source ?? 'unknown',
          durationMs,
          preview: truncated.text.slice(0, 200),
          argsKey,
          errorType: extractErrorType(dispatched.isError, truncated.text),
        }
      }

      const isParallel = input.parallelSafeClassifier
        ? classifyParallelSafe(input.parallelSafeClassifier, call)
        : !!parallelSafe?.has(call.name)
      if (isParallel) {
        pendingTasks.push(runDispatch())
      } else {
        // Serial barrier: drain accumulated parallel work first.
        if (pendingTasks.length > 0) {
          await Promise.allSettled(pendingTasks.splice(0))
        }
        await runDispatch()
      }
    }

    // End-of-iteration drain for any tail parallel tasks.
    if (pendingTasks.length > 0) {
      await Promise.allSettled(pendingTasks.splice(0))
    }

    // Commit slots in original call order so tool_call_id ↔ tool_result
    // alignment is preserved regardless of dispatch completion order.
    // Slots may be null if the loop aborted mid-iteration — skip those.
    // v1.2.111 — write one audit row per tool call (including denies +
    // schema-validation failures + dispatcher errors) so post-hoc trace
    // analysis can reconstruct the full chain inside a turn.
    for (let idx = 0; idx < result.toolCalls.length; idx++) {
      const h = historySlots[idx]
      const r = reportSlots[idx]
      if (h) history.push(h)
      if (r) {
        toolCalls.push(r)
        writeToolCallAudit(input.audit, r)
      }
    }

    // v1.2.108 — stuck-loop detector (now post-batch). Keyed on
    // (name, argsKey, errorType) of the last 3 entries; with parallel
    // batching this still fires correctly when 3 identical calls land
    // in a row (whether in one batch or across batches).
    if (isStuckLoop(toolCalls)) {
      const a = toolCalls[toolCalls.length - 1]!
      log.warn({
        event: 'agent-loop.stuck_loop_detected',
        tool: a.name,
        isError: a.isError,
        argsKeySnippet: a.argsKey.slice(0, 200),
        errorType: a.errorType,
        iter,
        totalToolCalls: toolCalls.length,
      }, `stuck loop: 3× ${a.name} with identical args + outcome — early stop at iter ${iter}`)
      signal.cleanup()
      return {
        // v1.2.117 — preserve accumulated partials.
        text: lengthRecoveryPrefix,
        iterations: iter + 1,
        toolCalls,
        usage: usageAcc,
        finishReason: 'stuck_loop',
      }
    }

    // v1.2.122 — semantic stuck-loop: same intent reshuffling across
    // different tool surfaces. Catches the failure mode where the model
    // tries Tavily → DDG → Brave (or read_file → cat → less) with the
    // same query/path. Disabled via AGIM_NATIVE_SEMANTIC_STUCK_LOOP=off.
    if (envCfg.semanticStuckLoopOn && isSemanticStuckLoop(toolCalls)) {
      const last3 = toolCalls.slice(-3)
      log.warn({
        event: 'agent-loop.semantic_stuck_loop_detected',
        tools: last3.map((t) => t.name),
        iter,
        totalToolCalls: toolCalls.length,
      }, `semantic stuck loop: 3 different tools repeated the same salient value — early stop at iter ${iter}`)
      signal.cleanup()
      return {
        text: lengthRecoveryPrefix,
        iterations: iter + 1,
        toolCalls,
        usage: usageAcc,
        finishReason: 'stuck_loop',
      }
    }

    // v1.2.98 / v1.2.99 / v1.2.109 — goal-critic check (semantic
    // off-track), now post-batch with a since-last-fire throttle so
    // cadence stays at-most-every-CRITIC_EVERY_N tool calls regardless
    // of how many calls landed in this iteration's batch.
    const criticMode = resolveCriticMode()
    const criticGateOpen = criticMode === 'always'
      || (criticMode === 'goal-only' && !!input.criticAnchor?.goalTitle?.trim())
    if (
      input.criticAnchor
      && criticGateOpen
      && toolCalls.length >= CRITIC_MIN_TOOL_CALLS
      && criticCallsFired < CRITIC_MAX_CALLS
      && toolCalls.length - lastCriticAtToolCalls >= CRITIC_EVERY_N
    ) {
      criticCallsFired += 1
      lastCriticAtToolCalls = toolCalls.length
      const recent = toolCalls.slice(-10)
      const verdict = await runGoalCritic({
        prompt: input.criticAnchor.prompt,
        goalTitle: input.criticAnchor.goalTitle,
        goalBody: input.criticAnchor.goalBody,
        recentToolCalls: recent,
      }, { signal: signal.signal })
      log.info({
        event: 'agent-loop.goal_critic_verdict',
        iter,
        totalToolCalls: toolCalls.length,
        onTrack: verdict.onTrack,
        reason: verdict.reason,
        modelUsed: verdict.modelUsed,
      })
      if (!verdict.onTrack) {
        log.warn({
          event: 'agent-loop.off_track_detected',
          iter,
          reason: verdict.reason,
          redirect: verdict.redirect,
        }, `goal-critic flagged off-track at iter ${iter}: ${verdict.reason}`)
        signal.cleanup()
        return {
          // v1.2.117 — preserve accumulated partials.
          text: lengthRecoveryPrefix,
          iterations: iter + 1,
          toolCalls,
          usage: usageAcc,
          finishReason: 'off_track',
          // Smuggle the critic's reason + redirect into `error` so
          // the native adapter can surface it verbatim in the recap
          // without re-importing goal-critic. Yes, abusing `error`
          // for non-error info is mildly ugly; alternative is adding
          // a new field to AgentLoopResult — overkill for one knob.
          error: verdict.redirect
            ? `${verdict.reason} || redirect: ${verdict.redirect}`
            : verdict.reason,
        }
      }
    }
    // Loop tail → next iteration calls provider with appended history.
  }

  // Fell off the loop without a non-tool_use finish → max iterations.
  signal.cleanup()
  return {
    // v1.2.117 — preserve accumulated partials.
    text: lengthRecoveryPrefix,
    iterations: iter,
    toolCalls,
    usage: usageAcc,
    finishReason: 'max_iterations',
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function normalizeLoopPolicies(
  policy: AgentLoopInput['loopPolicy'],
): readonly AgentLoopPolicy[] {
  if (!policy) return []
  if (Array.isArray(policy)) return policy as readonly AgentLoopPolicy[]
  return [policy as AgentLoopPolicy]
}

async function prepareNextTurn(
  policies: readonly AgentLoopPolicy[],
  ctx: AgentLoopPrepareNextTurnContext,
): Promise<LlmMessage[]> {
  if (policies.length === 0) return []
  const out: LlmMessage[] = []
  for (const policy of policies) {
    if (!policy.prepareNextTurn) continue
    try {
      const next = await policy.prepareNextTurn(ctx)
      if (!next) continue
      if (Array.isArray(next)) out.push(...next)
      else out.push(next)
    } catch (err) {
      log.warn({
        event: 'agent-loop.prepare_next_turn_threw',
        err: err instanceof Error ? err.message : String(err),
        iter: ctx.iter,
      })
    }
  }
  return out
}

async function shouldStopAfterTurn(
  policies: readonly AgentLoopPolicy[],
  ctx: AgentLoopStopAfterTurnContext,
): Promise<AgentLoopStopDecision | undefined> {
  if (policies.length === 0) return undefined
  for (const policy of policies) {
    if (!policy.shouldStopAfterTurn) continue
    try {
      const decision = await policy.shouldStopAfterTurn(ctx)
      if (decision) return decision
    } catch (err) {
      log.warn({
        event: 'agent-loop.should_stop_after_turn_threw',
        err: err instanceof Error ? err.message : String(err),
        iter: ctx.iter,
      })
    }
  }
  return undefined
}

type ResolvedToolAccess = {
  decision: 'allow' | 'deny'
  source: 'policy' | 'approval'
  reason?: string
}

function normalizeToolPolicyDecision(
  decision: ToolPolicyDecision | undefined,
  source: ResolvedToolAccess['source'],
): ResolvedToolAccess | undefined {
  if (!decision) return undefined
  if (decision === 'allow' || decision === 'deny') return { decision, source }
  return {
    decision: decision.decision,
    source,
    reason: decision.reason,
  }
}

async function decideToolAccess(
  policy: AgentToolPolicy | undefined,
  approve: ApprovalGate,
  ctx: AgentToolPolicyContext,
): Promise<ResolvedToolAccess> {
  if (policy?.canRunTool) {
    try {
      const gate = normalizeToolPolicyDecision(await policy.canRunTool(ctx), 'policy')
      if (gate?.decision === 'deny') return gate
    } catch (err) {
      log.warn({
        event: 'agent-loop.tool_policy_threw',
        hook: 'canRunTool',
        tool: ctx.call.name,
        err: err instanceof Error ? err.message : String(err),
      })
      return { decision: 'deny', source: 'policy', reason: 'policy hook threw' }
    }
  }

  if (policy?.approveToolRun) {
    try {
      const decision = normalizeToolPolicyDecision(await policy.approveToolRun(ctx), 'approval')
      return decision ?? { decision: 'deny', source: 'approval', reason: 'approval hook returned no decision' }
    } catch (err) {
      log.warn({
        event: 'agent-loop.tool_policy_threw',
        hook: 'approveToolRun',
        tool: ctx.call.name,
        err: err instanceof Error ? err.message : String(err),
      })
      return { decision: 'deny', source: 'approval', reason: 'approval hook threw' }
    }
  }

  return {
    decision: await safeApprove(approve, ctx.call, ctx.attempt),
    source: 'approval',
  }
}

/**
 * v1.2.118 — race a dispatcher against a per-tool wall timeout. The
 * outer abort signal (loop timeout / user cancel) is forwarded to the
 * dispatcher so it can clean up; on timeout we abort the dispatcher's
 * signal AND return a structured "timed out" tool-result so the model
 * sees a tool-level failure (not a thrown rejection).
 *
 * `timeoutMs === 0` disables the per-tool cap for this call — used for
 * long_task etc. that are explicitly slow.
 */
async function dispatchWithTimeout(
  invoke: (signal: AbortSignal) => Promise<DispatcherResult>,
  outerSignal: AbortSignal,
  timeoutMs: number,
  toolName: string,
): Promise<DispatcherResult> {
  if (timeoutMs === 0) return invoke(outerSignal)
  const ctrl = new AbortController()
  const onOuterAbort = (): void => ctrl.abort(outerSignal.reason ?? new Error('outer abort'))
  if (outerSignal.aborted) onOuterAbort()
  else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const timeout = new Promise<DispatcherResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      try { ctrl.abort(new Error(`tool ${toolName} timed out after ${timeoutMs}ms`)) } catch { /* ignore */ }
      resolve({
        text: `tool ${toolName} timed out after ${timeoutMs}ms (set AGIM_NATIVE_TOOL_TIMEOUT_MS or the tool's timeoutMs to raise the cap)`,
        isError: true,
        source: 'timeout',
      })
    }, timeoutMs)
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref()
    }
  })
  try {
    return await Promise.race([invoke(ctrl.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    outerSignal.removeEventListener('abort', onOuterAbort)
    if (timedOut) {
      log.warn({ event: 'agent-loop.tool_timeout', tool: toolName, timeoutMs })
    }
  }
}

function mergeUsage(acc: LlmUsage, add: LlmUsage): void {
  if (typeof add.promptTokens === 'number') {
    acc.promptTokens = (acc.promptTokens ?? 0) + add.promptTokens
  }
  if (typeof add.completionTokens === 'number') {
    acc.completionTokens = (acc.completionTokens ?? 0) + add.completionTokens
  }
  if (typeof add.totalTokens === 'number') {
    acc.totalTokens = (acc.totalTokens ?? 0) + add.totalTokens
  }
  if (typeof add.costUsd === 'number') {
    acc.costUsd = (acc.costUsd ?? 0) + add.costUsd
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}

function mergeSignal(userSignal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal; cleanup: () => void
} {
  if (!userSignal && !timeoutMs) {
    const ctrl = new AbortController()
    return { signal: ctrl.signal, cleanup: () => { /* nothing */ } }
  }
  const ctrl = new AbortController()
  let timer: NodeJS.Timeout | null = null
  const onAbort = () => ctrl.abort(userSignal?.reason ?? new Error('aborted'))
  if (userSignal) {
    if (userSignal.aborted) onAbort()
    else userSignal.addEventListener('abort', onAbort, { once: true })
  }
  if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(new Error(`agent loop timed out after ${timeoutMs}ms`)), timeoutMs)
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref()
    }
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      if (userSignal) userSignal.removeEventListener('abort', onAbort)
    },
  }
}

/** T2 — run the caller's per-call concurrency classifier, fail-closed.
 *  A classifier that throws (or any non-true return) means "serial" so a
 *  buggy predicate degrades throughput rather than crashing the turn. */
function classifyParallelSafe(
  classifier: (call: ToolCallRequest) => boolean,
  call: ToolCallRequest,
): boolean {
  try {
    return classifier(call) === true
  } catch (err) {
    log.warn({
      event: 'agent-loop.parallel_classifier_threw',
      tool: call.name,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

async function safeApprove(
  gate: ApprovalGate,
  call: ToolCallRequest,
  attempt: number,
): Promise<'allow' | 'deny'> {
  try {
    return await gate(call, attempt)
  } catch (err) {
    log.warn({
      event: 'agent-loop.approve_threw',
      tool: call.name,
      err: err instanceof Error ? err.message : String(err),
    })
    // Fail closed when the gate itself errors: better safe than sorry.
    return 'deny'
  }
}

function writeIterAudit(
  audit: AgentLoopInput['audit'] | undefined,
  startedAt: number,
  promptLen: number,
  responseLen: number,
  success: boolean,
  error?: string,
  cost?: number,
): void {
  if (!audit) return
  try {
    logInvocation({
      traceId: audit.traceId ?? `agent-loop-${Date.now()}`,
      userId: audit.userId ?? '',
      platform: audit.platform ?? 'native-agent',
      agent: audit.agent,
      intent: audit.intent ?? 'native.agent.iter',
      promptLen,
      responseLen,
      durationMs: Date.now() - startedAt,
      cost: typeof cost === 'number' ? cost : 0,
      success,
      error,
    })
  } catch { /* audit best-effort */ }
}

/** v1.2.111 — one row per tool call (deny / schema-validation /
 *  dispatched) so post-hoc trace analysis can reconstruct the full
 *  chain inside a turn. Intent is `tool.<name>` so queries can group
 *  per tool; agent is the original `audit.agent` so a tool call still
 *  shows under the parent agent in cost / topN aggregates. promptLen
 *  carries argsKey length (a rough "how much did the model send")
 *  bound, responseLen carries result preview length. error carries the
 *  validator/dispatcher's errorType so a failure mode aggregates
 *  cleanly in the audit dashboard. */
function writeToolCallAudit(
  audit: AgentLoopInput['audit'] | undefined,
  report: ToolCallReport,
): void {
  if (!audit) return
  try {
    logInvocation({
      traceId: audit.traceId ?? `agent-loop-${Date.now()}`,
      userId: audit.userId ?? '',
      platform: audit.platform ?? 'native-agent',
      agent: audit.agent,
      intent: `tool.${report.name}`,
      promptLen: report.argsKey?.length ?? 0,
      responseLen: report.preview?.length ?? 0,
      durationMs: report.durationMs,
      cost: 0, // tools themselves don't bill; LLM cost is on the iter row
      success: !report.isError,
      error: report.errorType || undefined,
    })
  } catch { /* audit best-effort */ }
}
