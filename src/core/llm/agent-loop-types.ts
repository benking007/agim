// agent-loop-types — all public types/interfaces for the agent loop.
// Extracted from agent-loop.ts; agent-loop.ts is now a re-export facade.

import type {
  ChatResult,
  FinishReason,
  LlmMessage,
  LlmUsage,
  ToolCallRequest,
  ToolChoice,
  ToolDef,
} from './provider-base.js'
import type { ToolDispatcher } from './tool-dispatcher.js'

export type MaybePromise<T> = T | Promise<T>

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
  signal?: AbortSignal,
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
  signal?: AbortSignal
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
  provider: import('./provider-base.js').LlmProvider
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
