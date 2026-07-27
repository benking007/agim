// agent-loop-run — the `runAgentLoop` implementation.
// Extracted from agent-loop.ts; agent-loop.ts is now a re-export facade.
//
// See agent-loop.ts for the full architecture comment.

import { logger as rootLogger } from '../logger.js'
import type { ChatResult, LlmMessage } from './provider-base.js'
import { runGoalCritic, resolveCriticMode, shouldHardStopOnOffTrack } from './goal-critic.js'
import { detectHallucinatedToolCall, isHallucinationDetectorOn } from './hallucination-detector.js'
import { validateAgainstSchema, formatValidationErrors } from './schema-validate.js'
import type { AgentLoopInput, AgentLoopResult, ToolCallReport } from './agent-loop-types.js'
import { alwaysAllowGate } from './agent-loop-types.js'
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TIMEOUT_MS,
  CRITIC_MIN_TOOL_CALLS,
  CRITIC_EVERY_N,
  CRITIC_MAX_CALLS,
  resolveSchemaValidate,
  resolveStreamEnabled,
  resolveLengthRecoveryMax,
  resolveBlankRetryMax,
  resolveToolResultMaxChars,
  resolveToolTimeoutMs,
  LENGTH_RECOVERY_MESSAGE,
  BLANK_RESPONSE_NUDGE,
} from './agent-loop-config.js'
import { streamWithFirstTokenRetry } from './agent-loop-stream.js'
import { stableStringify, extractErrorType, isStuckLoop, isSemanticStuckLoop, resolveSemanticStuckLoopOn } from './agent-loop-stuck.js'
import {
  mergeSignal,
  mergeUsage,
  clampInt,
  normalizeLoopPolicies,
  prepareNextTurn,
  shouldStopAfterTurn,
  decideToolAccess,
  dispatchWithTimeout,
  classifyParallelSafe,
  writeIterAudit,
  writeToolCallAudit,
  truncateToolResult,
} from './agent-loop-helpers.js'

const log = rootLogger.child({ component: 'agent-loop' })

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

  // v1.2.110 — build a name → schema map once so the per-iteration
  // tool-args validator (just before dispatch) can look up the declared
  // shape in O(1). When the validator is disabled or a tool isn't in
  // the map (caller didn't declare it; defensive), validation is a no-op.
  const schemaValidateOn = resolveSchemaValidate()
  const schemaByName = new Map<string, unknown>(
    (tools ?? []).map((t) => [t.name, t.parameters]),
  )

  // v1.2.112 — streaming is the caller opt-in (input.streamPartialText)
  // AND the env kill switch must allow it. Off by default for backward
  // compatibility — callers that want partial-on-abort opt in.
  const streamEnabled = !!input.streamPartialText && resolveStreamEnabled()

  // Local copy so we don't mutate the caller's array.
  const history: LlmMessage[] = input.messages.slice()
  const toolCalls: ToolCallReport[] = []
  const usageAcc = {}
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
  const lengthRecoveryMax = resolveLengthRecoveryMax()
  let lengthRecoveryPrefix = ''
  // v1.2.119 — intra-loop blank-response retry counter. Independent
  // from length-recovery (which fires when text *is* present but cut);
  // this fires when text + tool_calls are BOTH empty mid-loop.
  let blankRetryCount = 0
  const blankRetryMax = resolveBlankRetryMax()

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

    for (const [idx, call] of result.toolCalls.entries()) {
      if (signal.signal.aborted) break

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
        signal: signal.signal,
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
      // agim-dispatcher's A2A path) so the whole turn shares one
      // trace prefix instead of each fan-out minting a fresh root.
      const dispatchCtx = { traceId: input.audit?.traceId }
      // v1.2.118 — per-tool wall timeout. We resolve it once per call
      // and merge a per-call AbortController with the loop's outer
      // signal so cancelling either trips the underlying dispatcher.
      const toolDef = tools?.find((t) => t.name === call.name)
      const perToolTimeoutMs = resolveToolTimeoutMs(toolDef?.timeoutMs)
      const toolResultMaxChars = resolveToolResultMaxChars()
      const runDispatch = async (): Promise<void> => {
        try { input.hooks?.onToolStart?.(call) } catch { /* observer must not break loop */ }
        const dispatchT0 = Date.now()
        let dispatched: import('./tool-dispatcher.js').DispatcherResult
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
        const durationMs = Date.now() - dispatchT0
        // v1.2.118 — apply per-tool-result byte cap so one chatty tool
        // can't poison the rest of the turn's context window.
        const truncated = truncateToolResult(dispatched.text, toolResultMaxChars, call.name)
        if (truncated.truncated) {
          log.info({
            event: 'agent-loop.tool_result_truncated',
            tool: call.name,
            originalLen: dispatched.text.length,
            capped: toolResultMaxChars,
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
    for (let slotIdx = 0; slotIdx < result.toolCalls.length; slotIdx++) {
      const h = historySlots[slotIdx]
      const r = reportSlots[slotIdx]
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
    const latestToolCall = toolCalls.at(-1)
    if (latestToolCall && isStuckLoop(toolCalls)) {
      const a = latestToolCall
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
    if (resolveSemanticStuckLoopOn() && isSemanticStuckLoop(toolCalls)) {
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
        // Concrete current-turn asks outrank Focus — do not hard-stop the
        // loop merely because tools are not advancing Focus. (Soft steer
        // lives in the Agim Agent adapter; this path has no steer channel.)
        if (!shouldHardStopOnOffTrack({ prompt: input.criticAnchor.prompt })) {
          log.info({
            event: 'agent-loop.off_track_ignored_for_concrete_ask',
            iter,
            reason: verdict.reason,
          }, `goal-critic off-track ignored (current ask wins over Focus) at iter ${iter}`)
        } else {
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
