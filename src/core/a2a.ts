// Agent-to-Agent (A2A) — Layer 1.
//
// Lets one agent (claude-code / opencode / codex …) call another via the
// `mcp__imhub__call_agent` tool. This module owns the runtime side of
// that flow:
//
//   bus.callAgent(runId, payload)
//     → callAgentByName(name, prompt, ctx, { parentJobId, callDepth })
//       1. validate (depth, self-call, workspace whitelist, agent available)
//       2. createInlineJob(parent_id, call_depth = caller+1)
//       3. agent.sendPrompt(...) into an async generator
//       4. accumulate chunks with timeout
//       5. markJobCompleted / markJobFailed
//       6. write audit row (type='a2a')
//       7. return { ok, result, jobId, durationMs }
//
// What this module DOES NOT do:
//   - Call sink.deliver. A2A results go back to the caller agent through
//     the MCP tool return value, not to the user's IM thread. (Layer 2
//     will let A2A optionally tee to IM via use_default_thread=true.)
//   - Touch session.messages on the caller's thread. The callee's prompt
//     and result are not part of the caller's chat history.
//   - Handle interrupted/recovery (Phase 3 still applies because we use
//     createInlineJob, which is automatically swept on restart).

import type { RouteContext } from './router.js'
import { registry } from './registry.js'
import { logger as rootLogger } from './logger.js'
import { workspaceRegistry } from './workspace.js'
import {
  createInlineJob,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
} from './job-board.js'
import { logInvocation } from './audit-log.js'

const log = rootLogger.child({ component: 'a2a' })

export const A2A_MAX_DEPTH_DEFAULT = 3
export const A2A_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000  // 10 min

export function isA2AEnabled(): boolean {
  return process.env.IMHUB_A2A_ENABLED !== '0'
}

export function getA2AMaxDepth(): number {
  const raw = process.env.IMHUB_A2A_MAX_DEPTH
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return A2A_MAX_DEPTH_DEFAULT
}

export function getA2ATimeoutMs(): number {
  const raw = process.env.IMHUB_A2A_TIMEOUT_DEFAULT_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return A2A_TIMEOUT_MS_DEFAULT
}

export interface CallAgentOpts {
  /** Parent inline-job id (caller). NULL for top-level user calls. */
  parentJobId?: number | null
  /** Caller's call_depth. New row will be set to caller + 1. */
  callerDepth?: number
  /** Caller agent name (for self-call check). RouteContext doesn't carry
   *  this in its type today; bus.callAgent looks it up from RunContext
   *  + the audit log's per-run state. Optional — when unset we skip the
   *  self-call check; the depth ceiling still prevents runaway chains. */
  callerAgent?: string
  /** Override timeout. Falls back to env / default. */
  timeoutMs?: number
}

export type CallAgentResult =
  | { ok: true;  result: string; jobId: number; agent: string; durationMs: number }
  | { ok: false; error: string;  jobId?: number; agent?: string }

/** Programmatic A2A entry. Invokes `agentName` with `prompt` under the
 *  given RouteContext. Does NOT touch session history, does NOT deliver
 *  to IM. Result is returned to the caller verbatim. */
export async function callAgentByName(
  agentName: string,
  prompt: string,
  ctx: RouteContext,
  opts: CallAgentOpts = {},
): Promise<CallAgentResult> {
  if (!isA2AEnabled()) {
    return { ok: false, error: 'A2A disabled (IMHUB_A2A_ENABLED=0)' }
  }

  const callerDepth = opts.callerDepth ?? 0
  const nextDepth = callerDepth + 1
  const maxDepth = getA2AMaxDepth()
  if (nextDepth > maxDepth) {
    log.warn({
      event: 'a2a.depth_exceeded', agentName, callerDepth, maxDepth, threadId: ctx.threadId,
    }, `call_agent rejected: depth ${nextDepth} > max ${maxDepth}`)
    return { ok: false, error: `call depth exceeded (max=${maxDepth})` }
  }

  // self-call: would be vacuous recursion. Caller agent name comes through
  // opts.callerAgent (bus knows it from the runId → RunContext lookup).
  // When unset (non-bus entry points) we skip the check; the depth ceiling
  // still prevents runaway chains.
  if (opts.callerAgent && opts.callerAgent === agentName) {
    log.warn({
      event: 'a2a.self_call_rejected', agentName, threadId: ctx.threadId,
    }, 'call_agent rejected: agent cannot call itself')
    return { ok: false, error: `cannot call self (${agentName})` }
  }

  const target = registry.findAgent(agentName)
  if (!target) {
    return { ok: false, error: `agent not found: ${agentName}` }
  }

  // Workspace whitelist applies to A2A the same way it does to /job create.
  // The caller's workspace is bound to ctx.userId; the callee must be
  // listed in that workspace's agents[].
  const ws = workspaceRegistry.resolve(ctx.userId || 'unknown')
  if (!ws.hasAgent(target.name)) {
    return {
      ok: false, agent: target.name,
      error: `agent "${target.name}" not in workspace "${ws.name}" whitelist`,
    }
  }

  const threadKey = `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`
  const jobId = createInlineJob({
    agent: target.name,
    prompt,
    threadKey,
    creatorId: ctx.userId ?? '',
    workspaceId: ws.id,
    parentId: opts.parentJobId ?? null,
    callDepth: nextDepth,
  })
  markJobRunning(jobId)

  const timeoutMs = opts.timeoutMs ?? getA2ATimeoutMs()
  const started = Date.now()
  log.info({
    event: 'a2a.invoke_start',
    callee: target.name, caller: opts.callerAgent ?? 'user',
    jobId, parentJobId: opts.parentJobId ?? null,
    callDepth: nextDepth, timeoutMs, threadId: ctx.threadId,
  }, `A2A → ${target.name}`)

  let result = ''
  let outcome: 'completed' | 'failed' | 'timeout' = 'completed'
  let errMsg = ''
  try {
    const gen = target.sendPrompt(`a2a-${jobId}`, prompt, [], {
      threadId: ctx.threadId,
      platform: ctx.platform,
      channelId: ctx.channelId,
      userId: ctx.userId,
    })
    result = await accumulateWithTimeout(gen, timeoutMs)
  } catch (err) {
    outcome = err instanceof TimeoutError ? 'timeout' : 'failed'
    errMsg = err instanceof Error ? err.message : String(err)
  }

  const durationMs = Date.now() - started

  if (outcome === 'completed') {
    markJobCompleted(jobId, result)
  } else {
    markJobFailed(jobId, errMsg || outcome)
  }

  // Audit. Same shape as the normal callAgentWithHistory invocations so
  // /audit and per-user budgets see A2A traffic the same way. The
  // `intent` slot carries 'a2a' for slicing.
  try {
    logInvocation({
      traceId: ctx.traceId ?? '',
      userId: ctx.userId ?? '',
      platform: ctx.platform,
      agent: target.name,
      intent: 'a2a',
      promptLen: prompt.length,
      responseLen: result.length,
      durationMs,
      cost: 0,
      success: outcome === 'completed',
      error: outcome === 'completed' ? undefined : (errMsg || outcome),
    })
  } catch (err) {
    log.debug({ event: 'a2a.audit_failed', err: String(err) }, 'audit write failed (continuing)')
  }

  if (outcome !== 'completed') {
    log.warn({
      event: 'a2a.invoke_end', outcome, jobId, durationMs, callee: target.name, err: errMsg,
    }, `A2A → ${target.name} ${outcome}: ${errMsg}`)
    return { ok: false, error: errMsg || outcome, jobId, agent: target.name }
  }

  log.info({
    event: 'a2a.invoke_end', outcome: 'ok', jobId, durationMs, callee: target.name, resultLen: result.length,
  }, `A2A → ${target.name} ok (${result.length} chars in ${durationMs}ms)`)
  return { ok: true, result, jobId, agent: target.name, durationMs }
}

// ─── helpers ──────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(ms: number) { super(`a2a timed out after ${ms}ms`) }
}

async function accumulateWithTimeout(
  gen: AsyncGenerator<string>,
  ms: number,
): Promise<string> {
  let acc = ''
  const deadline = Date.now() + ms
  // Drain the generator with a per-step race against a deadline check.
  // We don't fight with the agent's internal stream — the timeout aborts
  // the AGGREGATION; the underlying spawn keeps running and gets logged
  // (caller's audit row gets outcome='timeout'). Future enhancement:
  // pass an AbortSignal to the adapter so the child actually terminates.
  while (true) {
    if (Date.now() >= deadline) throw new TimeoutError(ms)
    const nextP = gen.next()
    const timeoutP = new Promise<{ done: true; value: undefined }>((_, reject) => {
      const t = setTimeout(() => reject(new TimeoutError(ms)), Math.max(0, deadline - Date.now()))
      // Don't leak the timer when next() resolves first.
      nextP.finally(() => clearTimeout(t)).catch(() => { /* nothing */ })
    })
    const step = await Promise.race([nextP, timeoutP]) as IteratorResult<string>
    if (step.done) return acc
    if (typeof step.value === 'string') acc += step.value
  }
}
