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
import { validateAgainstSchema, formatValidationErrors } from './schema-validate.js'

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

/** v1.2.110 — gate the tool-args schema validator. Default ON; ops can
 *  flip OFF via env if a vendor schema confuses the lightweight
 *  validator (e.g. uses $ref / oneOf which we don't implement). The
 *  escape hatch keeps a footgun small. */
function resolveSchemaValidate(): boolean {
  const raw = (process.env.IMHUB_TOOL_SCHEMA_VALIDATE ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false
  return true
}

/**
 * Deterministic JSON.stringify with sorted object keys at every level.
 * Used by the stuck-loop detector to derive a stable identity key for
 * tool-call arguments: identical calls hash to identical strings
 * regardless of key insertion order. Tolerates circular references and
 * non-JSON-able values by collapsing them to a placeholder.
 */
export function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return 'null'
  if (typeof value === 'undefined') return 'null'
  if (typeof value === 'function') return '"[fn]"'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (seen.has(value as object)) return '"[circular]"'
  seen.add(value as object)
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v, seen)).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k], seen)).join(',') + '}'
}

/**
 * Stable error-type fingerprint of a dispatcher's result text. Returns
 * the first non-empty line trimmed and truncated to 80 chars when
 * isError; empty string otherwise. Used by the stuck-loop detector so
 * "fs_read failed with ENOENT three times" → stuck, but "fs_read
 * returned different bytes three times" → not stuck.
 */
export function extractErrorType(isError: boolean, text: string): string {
  if (!isError) return ''
  const firstNonEmpty = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstNonEmpty.trim().slice(0, 80)
}

/** True iff the last 3 entries are the same tool called with identical
 *  args resulting in the identical outcome — the stuck-loop signal. */
export function isStuckLoop(
  reports: Array<Pick<ToolCallReport, 'name' | 'argsKey' | 'errorType'>>,
): boolean {
  if (reports.length < 3) return false
  const a = reports[reports.length - 1]!
  const b = reports[reports.length - 2]!
  const c = reports[reports.length - 3]!
  return a.name === b.name && b.name === c.name
    && a.argsKey === b.argsKey && b.argsKey === c.argsKey
    && a.errorType === b.errorType && b.errorType === c.errorType
}

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

/** Auxiliary finish reasons the agent loop adds on top of the provider's
 *  finishReason vocabulary.
 *
 *  - `stuck_loop` (v1.2.95): the loop terminated early because the model
 *    called the SAME tool with the SAME outcome (error+preview hash)
 *    three iterations in a row — usually means it's stuck re-trying a
 *    failing SQL / fetch / command without changing strategy. Without
 *    this break a stuck model would burn the full
 *    IMHUB_NATIVE_AGENT_MAX_ITER budget; stopping early saves cost AND
 *    gives the user a much more actionable recap. */
/**  - `off_track` (v1.2.98): goal-critic flagged the recent tool chain
 *    as semantically off-target for the user's prompt / active goal.
 *    Different from stuck_loop (mechanical repeat) — this catches the
 *    "different calls but still pointless" failure mode. */
export type LoopFinishReason = FinishReason | 'max_iterations' | 'aborted' | 'stuck_loop' | 'off_track'

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
   *  setting IMHUB_NATIVE_CRITIC=off) disables the critic for this
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

  // v1.2.110 — build a name → schema map once so the per-iteration
  // tool-args validator (just before dispatch) can look up the declared
  // shape in O(1). When the validator is disabled or a tool isn't in
  // the map (caller didn't declare it; defensive), validation is a no-op.
  const schemaValidateOn = resolveSchemaValidate()
  const schemaByName = new Map<string, unknown>(
    (tools ?? []).map((t) => [t.name, t.parameters]),
  )

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

  let iter = 0
  for (; iter < maxIter; iter++) {
    if (signal.signal.aborted) {
      signal.cleanup()
      return {
        text: '',
        iterations: iter,
        toolCalls,
        usage: usageAcc,
        finishReason: 'aborted',
      }
    }

    let result: ChatResult
    const t0 = Date.now()
    try {
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
        text: '',
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

    // No tools, or model decided not to call any → terminate.
    if (result.finishReason !== 'tool_use' || !result.toolCalls || result.toolCalls.length === 0) {
      signal.cleanup()
      return {
        text: result.text,
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

      // Approval is ALWAYS serial — it may block on user input, and we
      // don't want to ask for N approvals simultaneously (the IM UI
      // would get spammed).
      const decision = await safeApprove(approve, call, iter)
      if (decision === 'deny') {
        const denyText = `tool call denied by user: ${call.name}`
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
      // self-corrected. Disabled when IMHUB_TOOL_SCHEMA_VALIDATE=off.
      const toolSchema = schemaByName.get(call.name)
      if (schemaValidateOn && toolSchema) {
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
      // imhub-dispatcher's A2A path) so the whole turn shares one
      // trace prefix instead of each fan-out minting a fresh root.
      const dispatchCtx = { traceId: input.audit?.traceId }
      const runDispatch = async (): Promise<void> => {
        try { input.hooks?.onToolStart?.(call) } catch { /* observer must not break loop */ }
        const t0 = Date.now()
        let dispatched: DispatcherResult
        try {
          dispatched = await dispatchCall(call, signal.signal, dispatchCtx)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          dispatched = { text: `tool threw: ${msg}`, isError: true, source: 'error' }
          log.warn({
            event: 'agent-loop.dispatch_threw',
            tool: call.name, err: msg,
          })
        }
        const durationMs = Date.now() - t0
        try { input.hooks?.onToolEnd?.(call, { isError: !!dispatched.isError, durationMs }) } catch { /* observer must not break loop */ }
        historySlots[idx] = {
          role: 'tool',
          toolCallId: call.id,
          content: dispatched.text,
        }
        reportSlots[idx] = {
          name: call.name,
          decision: 'allow',
          isError: dispatched.isError,
          source: dispatched.source ?? 'unknown',
          durationMs,
          preview: dispatched.text.slice(0, 200),
          argsKey,
          errorType: extractErrorType(dispatched.isError, dispatched.text),
        }
      }

      const isParallel = !!parallelSafe?.has(call.name)
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
        text: '',
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
          text: '',
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
    text: '',
    iterations: iter,
    toolCalls,
    usage: usageAcc,
    finishReason: 'max_iterations',
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

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
