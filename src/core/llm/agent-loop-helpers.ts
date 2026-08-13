// agent-loop-helpers — internal helpers for the agent loop (policy dispatch,
// audit writers, signal/usage utilities). Extracted from agent-loop.ts;
// agent-loop.ts is now a re-export facade.

import { logger as rootLogger } from '../logger.js'
import { logInvocation } from '../audit-log.js'
import type { LlmMessage, ToolCallRequest } from './provider-base.js'
import type { DispatcherResult } from './tool-dispatcher.js'
import {
  dispatchToolWithTimeout,
  EN_TOOL_TIMEOUT_MESSAGES,
} from './tool-call-spine.js'
import type {
  AgentLoopInput,
  AgentLoopPolicy,
  AgentLoopPrepareNextTurnContext,
  AgentLoopStopAfterTurnContext,
  AgentLoopStopDecision,
  AgentToolPolicy,
  AgentToolPolicyContext,
  ApprovalGate,
  ToolCallReport,
  ToolPolicyDecision,
} from './agent-loop-types.js'

const log = rootLogger.child({ component: 'agent-loop' })

// ─── loop policy helpers ──────────────────────────────────────────────

export function normalizeLoopPolicies(
  policy: AgentLoopInput['loopPolicy'],
): readonly AgentLoopPolicy[] {
  if (!policy) return []
  if (Array.isArray(policy)) return policy as readonly AgentLoopPolicy[]
  return [policy as AgentLoopPolicy]
}

export async function prepareNextTurn(
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

export async function shouldStopAfterTurn(
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

// ─── tool access / approval ───────────────────────────────────────────

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

export async function decideToolAccess(
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
    decision: await safeApprove(approve, ctx.call, ctx.attempt, ctx.signal),
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
 * `timeoutMs === 0` disables the per-tool cap for explicitly slow calls.
 * `detachOnAbort` (default true): return immediately on timeout/abort
 * (retired loop / read-only). False waits for the dispatcher to settle
 * so mutations cannot land after the caller has moved on.
 */
export async function dispatchWithTimeout(
  invoke: (signal: AbortSignal) => Promise<DispatcherResult>,
  outerSignal: AbortSignal,
  timeoutMs: number,
  toolName: string,
  detachOnAbort = true,
): Promise<DispatcherResult> {
  try {
    return await dispatchToolWithTimeout(invoke, outerSignal, timeoutMs, toolName, {
      detachOnAbort,
      messages: EN_TOOL_TIMEOUT_MESSAGES,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      err instanceof Error
      && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timed out|cancelled/i.test(msg))
    ) {
      return {
        text: msg,
        isError: true,
        source: err.name === 'AbortError' ? 'error' : 'timeout',
      }
    }
    throw err
  }
}

// ─── usage / signal utilities ─────────────────────────────────────────

export function mergeUsage(acc: import('./provider-base.js').LlmUsage, add: import('./provider-base.js').LlmUsage): void {
  if (typeof add.promptTokens === 'number') {
    acc.promptTokens = (acc.promptTokens ?? 0) + add.promptTokens
  }
  if (typeof add.completionTokens === 'number') {
    acc.completionTokens = (acc.completionTokens ?? 0) + add.completionTokens
  }
  if (typeof add.totalTokens === 'number') {
    acc.totalTokens = (acc.totalTokens ?? 0) + add.totalTokens
  }
  if (typeof add.cacheReadTokens === 'number') {
    acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + add.cacheReadTokens
  }
  if (typeof add.cacheMissTokens === 'number') {
    acc.cacheMissTokens = (acc.cacheMissTokens ?? 0) + add.cacheMissTokens
  }
  if (typeof add.costUsd === 'number') {
    acc.costUsd = (acc.costUsd ?? 0) + add.costUsd
  }
}

export function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}

export function mergeSignal(userSignal: AbortSignal | undefined, timeoutMs: number | undefined): {
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
export function classifyParallelSafe(
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

export async function safeApprove(
  gate: ApprovalGate,
  call: ToolCallRequest,
  attempt: number,
  signal?: AbortSignal,
): Promise<'allow' | 'deny'> {
  try {
    return await gate(call, attempt, signal)
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

// ─── audit writers ────────────────────────────────────────────────────

export function writeIterAudit(
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
export function writeToolCallAudit(
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

/** Truncate tool-result text with a clear marker so the model knows
 *  bytes were dropped. Single-pass over text; cap === 0 disables. */
export function truncateToolResult(text: string, cap: number, toolName: string): { text: string; truncated: boolean } {
  if (cap === 0 || text.length <= cap) return { text, truncated: false }
  const dropped = text.length - cap
  const marker = `\n\n…[${toolName} output truncated: ${dropped} of ${text.length} chars omitted; set AGIM_NATIVE_TOOL_RESULT_MAX_CHARS to raise the cap]`
  return { text: text.slice(0, cap) + marker, truncated: true }
}
