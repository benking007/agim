// Agent-to-Agent (A2A) — Layer 1.
//
// Lets one agent (claude-code / opencode / codex …) call another via the
// `mcp__agim__call_agent` tool. This module owns the runtime side of
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
import type { AgentTurnOutcome, ToolActivityStep } from './types.js'
import { registry } from './registry.js'
import { logger as rootLogger } from './logger.js'
import { workspaceRegistry } from './workspace.js'
import {
  bindJobController,
  cancelJob,
  createInlineJob,
  getJob,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  setJobResult,
} from './job-board.js'
import { logInvocation } from './audit-log.js'
import { applyGoalTimeoutBoost } from './goals.js'
import { buildSkillsSummary } from './skills/loader.js'
import {
  buildEnvelope,
  copyInputs,
  ensureArtifactsDir,
  getArtifactsDir,
  listOutputs,
  writeOutput,
  type InputSource,
  type OutputFile,
} from './artifacts.js'
import {
  notifyA2AStart,
  notifyA2AComplete,
  notifyA2ATimeout,
  notifyA2AFailed,
  startHeartbeat,
} from './a2a-notify.js'
import { isSameAgent, parseCallAgentTarget } from './subagent.js'

const log = rootLogger.child({ component: 'a2a' })

// Default A2A call-chain depth ceiling. A caller at depth D may delegate to
// depth D+1; this caps how deep nested call_agent chains can go. Default 8
// allows fairly deep multi-agent delegation out of the box (A→B→C→…, up to
// 8 levels) rather than the previous shallow cap of 1.
//
// Override with AGIM_A2A_MAX_DEPTH=N. Set N=1 to restrict to a single
// delegation hop; set N=0 to disable A2A entirely.
export const A2A_MAX_DEPTH_DEFAULT = 8
// v1.1.10: bumped from 10 min to 30 min after the HSTECH debate run revealed
// codex routinely takes 15-25 min when the prompt asks for ~4 API pulls + a
// report. 10 min cut codex off mid-write and produced orphan output files.
export const A2A_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000  // 30 min
/** Hard upper bound — refuse caller-supplied `timeoutMs` larger than this so
 *  an agent can't accidentally write `timeoutMs: 86400000` and block A2A
 *  forever. Override with AGIM_A2A_MAX_TIMEOUT_MS. */
export const A2A_TIMEOUT_MS_MAX = 60 * 60 * 1000  // 1 h

export function isA2AEnabled(): boolean {
  return process.env.AGIM_A2A_ENABLED !== '0'
}

export function getA2AMaxDepth(): number {
  const raw = process.env.AGIM_A2A_MAX_DEPTH
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return A2A_MAX_DEPTH_DEFAULT
}

// Sub-output compression: a callee's full final-text is injected into the
// CALLER's LLM context. A long report (a 30k-char research dump) burns the
// caller's window for little marginal value. Cap what the caller sees; spill
// the full text to _agim-output/ so it can `read` the rest on demand.
export const A2A_MAX_RESULT_CHARS_DEFAULT = 8000
/** File the over-long result is spilled to, under the callee's _agim-output/. */
export const A2A_FULL_RESULT_FILE = '__a2a_result_full.md'

/** Caller-visible result cap in chars. `AGIM_A2A_MAX_RESULT_CHARS=0` disables
 *  truncation (return the full text); unset → default. */
export function getA2AMaxResultChars(): number {
  const raw = process.env.AGIM_A2A_MAX_RESULT_CHARS
  if (raw === undefined || raw.trim() === '') return A2A_MAX_RESULT_CHARS_DEFAULT
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : A2A_MAX_RESULT_CHARS_DEFAULT
}

/** Cap `result` for the caller's context; spill the full text to _agim-output/
 *  when truncated. Returns the (possibly shortened) string. Spill failure falls
 *  back to the full result rather than losing content. */
export async function compressA2AResult(jobId: number, result: string): Promise<string> {
  const cap = getA2AMaxResultChars()
  if (cap <= 0 || result.length <= cap) return result
  try {
    await writeOutput(jobId, A2A_FULL_RESULT_FILE, result)
    return `${result.slice(0, cap)}\n\n…[已截断：子代理输出 ${result.length} 字符超过上限 ${cap}；完整内容见 _agim-output/${A2A_FULL_RESULT_FILE}（用 read 工具查看）]`
  } catch (err) {
    log.warn({ event: 'a2a.result_spill_failed', jobId, err: String(err) }, 'A2A result spill failed; returning full text')
    return result
  }
}

export function getA2ATimeoutMs(ctx?: { platform?: string; channelId?: string; threadId?: string }): number {
  const raw = process.env.AGIM_A2A_TIMEOUT_DEFAULT_MS
  let base = A2A_TIMEOUT_MS_DEFAULT
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) base = Math.min(n, getA2AMaxTimeoutMs())
  }
  // v1.2.86 — goal-aware timeout boost. When the addressed thread has
  // an active long-task goal, multiply the default by
  // AGIM_GOAL_ACTIVE_TIMEOUT_MULTIPLIER (3× default, 6 h hard cap).
  if (ctx) base = applyGoalTimeoutBoost(base, ctx)
  return base
}

export function getA2AMaxTimeoutMs(): number {
  const raw = process.env.AGIM_A2A_MAX_TIMEOUT_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return A2A_TIMEOUT_MS_MAX
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
  /** Parent tool/turn cancellation. Aborting it terminates the callee in
   *  addition to A2A's own timeout controller. */
  signal?: AbortSignal
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
  /** v1.2.139 — when the caller is currently in Plan Mode, propagate
   *  the flag to the callee so the sub-agent also runs read-only. Without
   *  this, a parent that hit /plan on would happily delegate write tasks
   *  to e.g. claude-code, which would launch with full write access and
   *  bypass the user's intent. */
  planMode?: boolean
  /** Web chat activity accordion — live "Waiting for subagent" steps.
   *  Prefer this over RouteContext.onToolActivity when both are set. */
  onToolActivity?: import('./types.js').AgentSendOpts['onToolActivity']
  /** Allow same-agent nested Subagent (isolated context). Vacuous self-call
   *  without isolate/model is still rejected. See docs/architecture/subagent.md. */
  isolate?: boolean
  /** Agim Agent backend name → `AgentSendOpts.model` (role already resolved). */
  model?: string
  /** Activity accordion label override (e.g. `agim/cheap`). */
  activityLabel?: string
  /**
   * Stable activity step id (usually the parent toolCallId). When set, the
   * Subagent card updates in place from pending → running → done instead of
   * opening a second `a2a-${jobId}` row.
   */
  activityStepId?: string
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
      /** True when the user (or parent) stopped the Subagent mid-run. */
      cancelled?: true
    }
  | { ok: false; error: string;  jobId?: number; agent?: string }

/** Tool-result text handed back to the parent after a user Stop. */
export function formatSubagentStoppedResult(partial: string): string {
  const body = partial.trim() || '(no output yet)'
  return [
    '[Subagent stopped by user]',
    'Partial output (may be incomplete):',
    '---',
    body,
    '---',
    'Instructions for parent: Summarize what is already known from the partial '
      + 'output above, update the Plan checklist if one exists, and continue with '
      + 'the next unfinished step. Do not re-spawn the same Subagent unless the user asks.',
  ].join('\n')
}

/** True when an AbortSignal reason looks like a wall-clock / turn timeout
 *  (as opposed to an explicit user Stop). */
export function isAbortReasonTimeout(reason: unknown): boolean {
  if (reason == null) return false
  if (typeof reason === 'string') {
    return /timed?\s*out|timeout|超时/i.test(reason)
  }
  if (typeof reason !== 'object') return false
  const name = 'name' in reason ? String((reason as { name: unknown }).name) : ''
  const message = 'message' in reason ? String((reason as { message: unknown }).message) : ''
  if (name === 'TimeoutError') return true
  return /timed?\s*out|timeout|超时|native run timed out|a2a timed out/i.test(message)
}

function abortPreview(reason: unknown, timeoutMs: number): string {
  if (isAbortReasonTimeout(reason)) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    const detail = reason instanceof Error && reason.message.trim()
      ? reason.message.trim().slice(0, 120)
      : `timed out after ${seconds}s`
    return detail
  }
  return 'Stopped by user'
}

function emitAgentActivity(
  opts: CallAgentOpts,
  ctx: RouteContext,
  step: ToolActivityStep,
): void {
  const emit = opts.onToolActivity ?? ctx.onToolActivity
  if (!emit) return
  try {
    emit(step)
  } catch { /* observer must not break A2A */ }
}

/** Mark the pending Subagent card failed when A2A bails before job start. */
function emitEarlyAgentFailure(
  opts: CallAgentOpts,
  ctx: RouteContext,
  agentName: string,
  error: string,
): void {
  const id = (typeof opts.activityStepId === 'string' && opts.activityStepId.trim())
    ? opts.activityStepId.trim()
    : `a2a-fail-${Date.now()}`
  const label = (typeof opts.activityLabel === 'string' && opts.activityLabel.trim())
    ? opts.activityLabel.trim()
    : agentName
  const now = Date.now()
  emitAgentActivity(opts, ctx, {
    id,
    kind: 'agent',
    label,
    status: 'error',
    startedAt: now,
    finishedAt: now,
    preview: error.slice(0, 180),
  })
}

/** Programmatic A2A entry. Invokes `agentName` with `prompt` under the
 *  given RouteContext. Does NOT touch session history, does NOT deliver
 *  to IM. Result is returned to the caller verbatim. */
export async function callAgentByName(
  agentName: string,
  prompt: string,
  ctx: RouteContext,
  rawOpts: CallAgentOpts = {},
): Promise<CallAgentResult> {
  // Defense in depth: models often pass schema-legacy "agim/native".
  const parsedTarget = parseCallAgentTarget(agentName)
  const resolvedAgentName = parsedTarget.agent || agentName
  const opts: CallAgentOpts = {
    ...rawOpts,
    ...(parsedTarget.isolate && !rawOpts.isolate ? { isolate: true } : {}),
  }

  const earlyFail = (error: string, agent?: string): CallAgentResult => {
    emitEarlyAgentFailure(opts, ctx, agent ?? resolvedAgentName, error)
    return agent ? { ok: false, error, agent } : { ok: false, error }
  }

  if (!isA2AEnabled()) {
    return earlyFail('A2A disabled (AGIM_A2A_ENABLED=0)')
  }

  const callerDepth = opts.callerDepth ?? 0
  const nextDepth = callerDepth + 1
  const maxDepth = getA2AMaxDepth()
  if (nextDepth > maxDepth) {
    log.warn({
      event: 'a2a.depth_exceeded',
      agentName: resolvedAgentName,
      callerDepth,
      maxDepth,
      threadId: ctx.threadId,
    }, `call_agent rejected: depth ${nextDepth} > max ${maxDepth}`)
    return earlyFail(`call depth exceeded (max=${maxDepth})`)
  }

  // Same-agent nested call is vacuous recursion unless this is an explicit
  // Subagent spawn (isolate and/or a concrete model/backend override).
  // Treat agim/native aliases (and registry aliases) as the same agent.
  // When callerAgent is unset we skip the check; depth still caps chains.
  if (
    opts.callerAgent
    && isSameAgent(opts.callerAgent, resolvedAgentName)
    && !opts.isolate
    && !(typeof opts.model === 'string' && opts.model.trim())
  ) {
    log.warn({
      event: 'a2a.self_call_rejected',
      agentName: resolvedAgentName,
      callerAgent: opts.callerAgent,
      threadId: ctx.threadId,
    }, 'call_agent rejected: agent cannot call itself without isolate/model')
    return earlyFail(
      `cannot call self (${resolvedAgentName}) without isolate/role/backend. `
        + `Pass isolate:true or a role/backend for a same-family Subagent.`,
    )
  }

  const target = registry.findAgent(resolvedAgentName)
  if (!target) {
    return earlyFail(`agent not found: ${resolvedAgentName}`)
  }

  // Workspace whitelist applies to A2A the same way it does to /job create.
  // The caller's workspace is bound to ctx.userId; the callee must be
  // listed in that workspace's agents[].
  const ws = workspaceRegistry.resolve(ctx.userId || 'unknown')
  if (!ws.hasAgent(target.name)) {
    return earlyFail(
      `agent "${target.name}" not in workspace "${ws.name}" whitelist`,
      target.name,
    )
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
  // Round-scoped Loop wait: register job id as soon as the row exists.
  if (jobId > 0) {
    try {
      const { noteLoopRoundJob } = await import('./loop-run.js')
      noteLoopRoundJob(ctx.platform, ctx.channelId, ctx.threadId, jobId)
    } catch {
      /* Loop store optional — never break A2A */
    }
  }
  const abortController = new AbortController()
  const unbindJobController = bindJobController(jobId, abortController)
  const onOuterAbort = () => abortController.abort(opts.signal?.reason)
  const cleanupController = () => {
    opts.signal?.removeEventListener('abort', onOuterAbort)
    unbindJobController()
  }
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  if (opts.signal?.aborted) onOuterAbort()
  if (!markJobRunning(jobId)) {
    cleanupController()
    emitEarlyAgentFailure(opts, ctx, target.name, 'a2a cancelled before start')
    return { ok: false, error: 'a2a cancelled before start', jobId, agent: target.name }
  }

  // L2 — provision artifacts dir + copy inputs BEFORE building the
  // envelope so the prompt envelope can list real files / sizes. Errors
  // from copyInputs (bad path, size cap, missing caller output) fail the
  // job up-front with a clean error message — no agent invocation, no
  // tokens spent.
  let copiedInputs: Array<{ name: string; bytes: number }> = []
  let promptWithEnvelope = prompt
  try {
    await ensureArtifactsDir(jobId)
    if (abortController.signal.aborted) throw new Error('a2a aborted during artifact setup')
    if (opts.inputs && opts.inputs.length > 0) {
      copiedInputs = await copyInputs(jobId, opts.inputs, opts.parentJobId ?? undefined)
      if (abortController.signal.aborted) throw new Error('a2a aborted during input copy')
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
    if (!target.handlesAgimSkillsPrompt) {
      const skillsSnippet = buildSkillsSummary()
      if (skillsSnippet) promptWithEnvelope = `${skillsSnippet}\n${promptWithEnvelope}`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ event: 'a2a.artifacts_setup_failed', jobId, err: msg },
      `A2A artifacts setup failed: ${msg}`)
    markJobFailed(jobId, msg)
    cleanupController()
    emitEarlyAgentFailure(opts, ctx, target.name, msg)
    return { ok: false, error: msg, jobId, agent: target.name }
  }

  // v1.1.10: clamp caller-supplied timeoutMs to the configured max so an
  // agent can't ask for an obscenely long timeout that blocks A2A.
  // v1.2.86: pass the route context so getA2ATimeoutMs can apply the
  // active-goal multiplier when present (no boost when caller already
  // supplied an explicit timeoutMs — they made an informed choice).
  const timeoutMs = Math.min(
    opts.timeoutMs ?? getA2ATimeoutMs({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
    }),
    getA2AMaxTimeoutMs(),
  )
  const started = Date.now()
  log.info({
    event: 'a2a.invoke_start',
    callee: target.name, caller: opts.callerAgent ?? 'user',
    jobId, parentJobId: opts.parentJobId ?? null,
    callDepth: nextDepth, timeoutMs, threadId: ctx.threadId,
    inputCount: copiedInputs.length,
    expectOutputCount: opts.expectOutputs?.length ?? 0,
  }, `A2A → ${target.name}`)

  // v1.1.10: surface intermediate state to the caller's IM thread. start
  // notice fires here, terminal notices after the call returns. fire-and-
  // forget — never let a notify failure break A2A.
  void notifyA2AStart(ctx, nextDepth, {
    jobId,
    callee: target.name,
    inputCount: copiedInputs.length,
    expectOutputs: opts.expectOutputs,
    callerAgent: opts.callerAgent,
  })
  const heartbeat = startHeartbeat(ctx, nextDepth, jobId, target.name)
  const activityLabel = (typeof opts.activityLabel === 'string' && opts.activityLabel.trim())
    ? opts.activityLabel.trim()
    : target.name
  const activityStepId = (typeof opts.activityStepId === 'string' && opts.activityStepId.trim())
    ? opts.activityStepId.trim()
    : `a2a-${jobId}`
  const activityStartedAt = Date.now()
  emitAgentActivity(opts, ctx, {
    id: activityStepId,
    kind: 'agent',
    label: activityLabel,
    status: 'running',
    startedAt: activityStartedAt,
    preview: prompt.slice(0, 120).replace(/\s+/g, ' '),
    jobId,
  })

  let result = ''
  let outcome: 'completed' | 'failed' | 'timeout' | 'cancelled' = 'completed'
  let errMsg = ''
  const calleeOutcomes: AgentTurnOutcome[] = []
  // v1.1.10: abortController is passed into sendPrompt so the underlying
  // child process actually terminates on timeout. Without this the callee
  // (codex / claude / opencode) keeps running and writes "orphan" files
  // into _agim-output/ long after agim has given up.
  try {
    const modelOverride = typeof opts.model === 'string' && opts.model.trim()
      ? opts.model.trim()
      : undefined
    const gen = target.sendPrompt(`a2a-${jobId}`, promptWithEnvelope, [], {
      threadId: ctx.threadId,
      platform: ctx.platform,
      channelId: ctx.channelId,
      userId: ctx.userId,
      traceId: ctx.traceId,
      // A2A-L1: forward our own jobId + nextDepth so the callee's adapter
      // stamps RunContext correctly. If the callee then fires
      // mcp__agim__call_agent itself, its bus.handleA2A sees
      // callDepth = our nextDepth → +1 = grand-callee depth, and
      // parent_id = jobId (our callee row).
      parentJobId: jobId,
      callDepth: nextDepth,
      // Same-family Subagent: pin Agim Agent to role/backend via model name.
      ...(modelOverride ? { model: modelOverride } : {}),
      // v1.2.139 — propagate parent's plan-mode state so the callee runs
      // read-only too. Without this, a parent under /plan on could delegate
      // a write task to claude-code and the child would launch with full
      // write access, bypassing the user's intent.
      ...(opts.planMode ? { planMode: true } : {}),
      signal: abortController.signal,
      onOutcome: (value) => { calleeOutcomes.push(value) },
    })
    result = await accumulateWithTimeout(gen, timeoutMs, abortController.signal)
    if (abortController.signal.aborted || opts.signal?.aborted || getJob(jobId)?.status === 'cancelled') {
      const reason = abortController.signal.reason ?? opts.signal?.reason
      // Parent-turn / tool-bridge / AbortSignal.timeout aborts used to be
      // mis-labeled "Stopped by user" even when no human clicked Stop.
      if (isAbortReasonTimeout(reason)) {
        outcome = 'timeout'
        errMsg = abortPreview(reason, timeoutMs)
      } else {
        outcome = 'cancelled'
        errMsg = 'stopped by user'
      }
    } else {
      const calleeOutcome = calleeOutcomes.at(-1)
      if (calleeOutcome && calleeOutcome.status !== 'success' && calleeOutcome.status !== 'partial') {
        outcome = calleeOutcome.status === 'timeout' ? 'timeout' : 'failed'
        errMsg = calleeOutcome.error ?? calleeOutcome.status
      }
    }
  } catch (err) {
    if (err instanceof TimeoutError) {
      outcome = 'timeout'
      errMsg = err.message
    } else if (abortController.signal.aborted || opts.signal?.aborted) {
      const reason = abortController.signal.reason ?? opts.signal?.reason ?? err
      if (isAbortReasonTimeout(reason)) {
        outcome = 'timeout'
        errMsg = abortPreview(reason, timeoutMs)
      } else {
        outcome = 'cancelled'
        errMsg = 'stopped by user'
      }
    } else {
      outcome = 'failed'
      errMsg = err instanceof Error ? err.message : String(err)
    }
    // Cancel the in-flight child. spawnStream listens on the signal and
    // sends SIGTERM (then SIGKILL after a grace period) to the agent CLI.
    try { abortController.abort() } catch { /* noop */ }
  } finally {
    cleanupController()
  }

  // Stop heartbeat ASAP so we don't race the terminal notice.
  heartbeat.stop()

  const durationMs = Date.now() - started

  if (outcome === 'completed') {
    markJobCompleted(jobId, result)
  } else if (outcome === 'cancelled') {
    // WS/UI cancelJob() may already have flipped status; always persist
    // partial text. If status is still running, cancel now with result.
    const row = getJob(jobId)
    if (row?.status === 'cancelled') {
      setJobResult(jobId, result || null)
    } else if (!cancelJob(jobId, { result: result || null })) {
      setJobResult(jobId, result || null)
    }
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
      success: outcome === 'completed' || outcome === 'cancelled',
      error: outcome === 'completed' || outcome === 'cancelled'
        ? undefined
        : (errMsg || outcome),
    })
  } catch (err) {
    log.debug({ event: 'a2a.audit_failed', err: String(err) }, 'audit write failed (continuing)')
  }

  if (outcome === 'cancelled') {
    const resultForParent = formatSubagentStoppedResult(result)
    log.info({
      event: 'a2a.invoke_end', outcome: 'cancelled', jobId, durationMs, callee: target.name,
      resultLen: result.length,
    }, `A2A → ${target.name} cancelled (${result.length} chars partial)`)
    emitAgentActivity(opts, ctx, {
      id: activityStepId,
      kind: 'agent',
      label: activityLabel,
      status: 'error',
      startedAt: activityStartedAt,
      finishedAt: Date.now(),
      preview: 'Stopped by user',
      jobId,
    })
    const artifactsDir = getArtifactsDir(jobId).outputDir
    const outputs = await listOutputs(jobId).catch(() => [] as OutputFile[])
    // ok:true so the parent turn continues — tool result asks it to summarize
    // partial progress and advance the next Plan step.
    return {
      ok: true,
      cancelled: true,
      result: resultForParent,
      jobId,
      agent: target.name,
      durationMs,
      artifactsDir,
      outputs,
    }
  }

  if (outcome !== 'completed') {
    log.warn({
      event: 'a2a.invoke_end', outcome, jobId, durationMs, callee: target.name, err: errMsg,
    }, `A2A → ${target.name} ${outcome}: ${errMsg}`)
    emitAgentActivity(opts, ctx, {
      id: activityStepId,
      kind: 'agent',
      label: activityLabel,
      status: 'error',
      startedAt: activityStartedAt,
      finishedAt: Date.now(),
      preview: (errMsg || outcome).slice(0, 180),
      jobId,
    })
    if (outcome === 'timeout') {
      void notifyA2ATimeout(ctx, nextDepth, { jobId, callee: target.name, durationMs })
    } else {
      void notifyA2AFailed(ctx, nextDepth, { jobId, callee: target.name, durationMs, error: errMsg || outcome })
    }
    return { ok: false, error: errMsg || outcome, jobId, agent: target.name }
  }

  // Sub-output compression: cap the caller-visible result; spill the full
  // text to _agim-output/ (BEFORE listOutputs so the spill file is listed).
  const resultForParent = await compressA2AResult(jobId, result)

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
  emitAgentActivity(opts, ctx, {
    id: activityStepId,
    kind: 'agent',
    label: activityLabel,
    status: 'success',
    startedAt: activityStartedAt,
    finishedAt: Date.now(),
    preview: `${Math.round(durationMs / 100) / 10}s · ${result.length} chars`,
    jobId,
  })
  void notifyA2AComplete(ctx, nextDepth, {
    jobId,
    callee: target.name,
    durationMs,
    outputs: outputs.map((o) => ({ name: o.name, bytes: o.bytes })),
  })
  return {
    ok: true, result: resultForParent, jobId, agent: target.name, durationMs,
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
  signal?: AbortSignal,
): Promise<string> {
  let acc = ''
  const deadline = Date.now() + ms
  // Drain the generator with a per-step race against deadline + abort.
  // Abort returns accumulated partial text so the parent can summarize.
  while (true) {
    if (signal?.aborted) return acc
    if (Date.now() >= deadline) throw new TimeoutError(ms)
    const nextP = gen.next()
    const timeoutP = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new TimeoutError(ms)), Math.max(0, deadline - Date.now()))
      nextP.finally(() => clearTimeout(t)).catch(() => { /* nothing */ })
    })
    const abortP = signal
      ? new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('a2a aborted'))
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
          nextP.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => { /* nothing */ })
        })
      : null
    try {
      const step = await Promise.race(
        abortP ? [nextP, timeoutP, abortP] : [nextP, timeoutP],
      ) as IteratorResult<string>
      if (step.done) return acc
      if (typeof step.value === 'string') acc += step.value
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && /a2a aborted/i.test(err.message))) {
        return acc
      }
      throw err
    }
  }
}
