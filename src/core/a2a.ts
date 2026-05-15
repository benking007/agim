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
import {
  buildEnvelope,
  copyInputs,
  ensureArtifactsDir,
  getArtifactsDir,
  listOutputs,
  type InputSource,
  type OutputFile,
} from './artifacts.js'

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
  /** L2: files to drop in the callee's _agim-input/ before it runs.
   *  Each input has a target filename plus exactly one of:
   *    - fromAbsolutePath: copy/hard-link from a path on disk
   *    - fromCallerOutput: pull from caller's own _agim-output/
   *      (requires parentJobId so artifacts knows which job to read)
   *    - content:          inline string content */
  inputs?: InputSource[]
  /** L2: filenames the callee is expected to produce under _agim-output/.
   *  Missing files at return time become entries in `warnings`, not a
   *  hard failure — the callee is still allowed to do what it deems
   *  best. */
  expectOutputs?: string[]
}

export type CallAgentResult =
  | {
      ok: true;  result: string; jobId: number; agent: string; durationMs: number
      /** L2: absolute path of the artifacts directory for this run. */
      artifactsDir: string
      /** L2: files the callee left under _agim-output/. */
      outputs: OutputFile[]
      /** L2: non-fatal advisories — e.g. expectOutputs that didn't show up. */
      warnings?: string[]
    }
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

  // L2 — provision artifacts dir + copy inputs BEFORE building the
  // envelope so the prompt envelope can list real files / sizes. Errors
  // from copyInputs (bad path, size cap, missing caller output) fail the
  // job up-front with a clean error message — no agent invocation, no
  // tokens spent.
  let copiedInputs: Array<{ name: string; bytes: number }> = []
  let promptWithEnvelope = prompt
  try {
    await ensureArtifactsDir(jobId)
    if (opts.inputs && opts.inputs.length > 0) {
      copiedInputs = await copyInputs(jobId, opts.inputs, opts.parentJobId ?? undefined)
    }
    const needEnvelope = copiedInputs.length > 0
      || (opts.expectOutputs && opts.expectOutputs.length > 0)
    if (needEnvelope) {
      const envelope = buildEnvelope({
        jobId,
        inputs: copiedInputs,
        expectOutputs: opts.expectOutputs,
      })
      promptWithEnvelope = `${envelope}\n${prompt}`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ event: 'a2a.artifacts_setup_failed', jobId, err: msg },
      `A2A artifacts setup failed: ${msg}`)
    markJobFailed(jobId, msg)
    return { ok: false, error: msg, jobId, agent: target.name }
  }

  const timeoutMs = opts.timeoutMs ?? getA2ATimeoutMs()
  const started = Date.now()
  log.info({
    event: 'a2a.invoke_start',
    callee: target.name, caller: opts.callerAgent ?? 'user',
    jobId, parentJobId: opts.parentJobId ?? null,
    callDepth: nextDepth, timeoutMs, threadId: ctx.threadId,
    inputCount: copiedInputs.length,
    expectOutputCount: opts.expectOutputs?.length ?? 0,
  }, `A2A → ${target.name}`)

  let result = ''
  let outcome: 'completed' | 'failed' | 'timeout' = 'completed'
  let errMsg = ''
  try {
    const gen = target.sendPrompt(`a2a-${jobId}`, promptWithEnvelope, [], {
      threadId: ctx.threadId,
      platform: ctx.platform,
      channelId: ctx.channelId,
      userId: ctx.userId,
      // A2A-L1: forward our own jobId + nextDepth so the callee's adapter
      // stamps RunContext correctly. If the callee then fires
      // mcp__imhub__call_agent itself, its bus.handleA2A sees
      // callDepth = our nextDepth → +1 = grand-callee depth, and
      // parent_id = jobId (our callee row).
      parentJobId: jobId,
      callDepth: nextDepth,
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

  // L2: collect callee outputs + softly verify expectOutputs. Missing
  // files become entries in `warnings`, never a hard failure — the
  // callee decided what to produce, our verification is advisory.
  const outputs = await listOutputs(jobId)
  const warnings: string[] = []
  if (opts.expectOutputs && opts.expectOutputs.length > 0) {
    const produced = new Set(outputs.map((f) => f.name))
    for (const expected of opts.expectOutputs) {
      if (!produced.has(expected)) {
        warnings.push(`expected output not produced: ${expected}`)
      }
    }
  }
  const artifactsDir = getArtifactsDir(jobId).outputDir

  log.info({
    event: 'a2a.invoke_end', outcome: 'ok', jobId, durationMs, callee: target.name,
    resultLen: result.length, outputCount: outputs.length, warningCount: warnings.length,
  }, `A2A → ${target.name} ok (${result.length} chars, ${outputs.length} outputs, in ${durationMs}ms)`)
  return {
    ok: true, result, jobId, agent: target.name, durationMs,
    artifactsDir, outputs,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
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
