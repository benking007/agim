// Thin RPC dispatcher for the approval-bus unix-socket protocol.
//
// Each handler validates the wire message, resolves a RunContext via the
// ApprovalRpcHost, lazy-imports the domain RPC module, and writes a result
// frame back on the socket. None of these handlers touch the pending-approval
// maps or the notifier — that path stays in ApprovalBus.handleApproval.

import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { logger as rootLogger } from '../logger.js'
import type { RunContext, Decision } from './types.js'

const log = rootLogger.child({ component: 'approval-bus' })

/** Minimal surface the RPC handlers need from the bus. */
export interface ApprovalRpcHost {
  /** Look up a registered RunContext by runId. Returns undefined if unknown. */
  getRunContext(runId: string): RunContext | undefined
  /** Register a synthetic pending approval (used by native_tool only). */
  registerSyntheticPending(input: {
    runId: string
    reqId: string
    toolName: string
    input: Record<string, unknown>
    toolUseId?: string
    ctx: RunContext
    dispatch: (decision: Decision) => void
  }): Promise<void>
}

/**
 * Dispatch an already-parsed wire message to the appropriate RPC handler.
 * Returns true if the type was handled here, false if the caller should
 * deal with it (e.g. 'approval' stays in ApprovalBus, unknown type → warn).
 */
export async function dispatchRpc(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<boolean> {
  if (m.type === 'a2a')         { await handleA2A(m, socket, host);         return true }
  if (m.type === 'reminder')    { await handleReminder(m, socket, host);    return true }
  if (m.type === 'memo')        { await handleMemo(m, socket, host);        return true }
  if (m.type === 'push')        { await handlePush(m, socket, host);        return true }
  if (m.type === 'ask')         { await handleAsk(m, socket, host);         return true }
  if (m.type === 'skill')       { await handleSkill(m, socket);             return true }
  if (m.type === 'native_tool') { await handleNativeTool(m, socket, host);  return true }
  if (m.type === 'memory')      { await handleMemory(m, socket, host);      return true }
  if (m.type === 'goal')        { await handleGoal(m, socket, host);        return true }
  return false
}

// ---------------------------------------------------------------------------
// Generic result sender
// ---------------------------------------------------------------------------

function sendResult(
  socket: Socket,
  wireType: string,
  reqId: string,
  result: { ok: true; result: unknown } | { ok: false; error: string },
  logEvent: string,
): void {
  if (!socket.writable) return
  const wire: Record<string, unknown> = { v: 1, type: wireType, reqId, ok: result.ok }
  if (result.ok) wire.result = result.result
  else wire.error = result.error
  socket.write(`${JSON.stringify(wire)}\n`, (err) => {
    if (err) log.warn({ event: logEvent, reqId, err: String(err) })
  })
}

// ---------------------------------------------------------------------------
// Shared context-resolution helper (runId + optional _im_context fallback)
// ---------------------------------------------------------------------------

interface CtxFallbackOpts {
  /** Wire event prefix for log lines (e.g. 'reminder', 'memo'). */
  prefix: string
  /** Whether _im_context fallback is permitted for this RPC type. */
  allowInlineCtx: boolean
}

function resolveRunContext(
  runId: string | null,
  payload: Record<string, unknown>,
  host: ApprovalRpcHost,
  { prefix, allowInlineCtx }: CtxFallbackOpts,
): RunContext | null {
  if (runId) {
    const ctx = host.getRunContext(runId)
    if (ctx) return ctx
  }
  if (!allowInlineCtx) return null
  const inlineCtx = payload._im_context
  if (inlineCtx && typeof inlineCtx === 'object' && !Array.isArray(inlineCtx)) {
    const ic = inlineCtx as Record<string, unknown>
    if (
      typeof ic.platform === 'string'
      && typeof ic.threadId === 'string'
      && typeof ic.channelId === 'string'
    ) {
      const ctx: RunContext = {
        platform: ic.platform,
        threadId: ic.threadId,
        channelId: ic.channelId,
        userId: typeof ic.userId === 'string' ? ic.userId : '',
      }
      log.info({
        event: `${prefix}.bus.inline_ctx`,
        platform: ctx.platform, threadId: ctx.threadId, runId,
      }, `${prefix} using agent-asserted _im_context (single-user mode)`)
      delete payload._im_context
      return ctx
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// A2A
// ---------------------------------------------------------------------------

async function handleA2A(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'a2a.bus.missing_reqId' }); return }
  if (!runId) { sendA2AResult(socket, reqId, { ok: false, error: 'missing runId' }); return }

  const ctx = host.getRunContext(runId)
  if (!ctx) { sendA2AResult(socket, reqId, { ok: false, error: `unknown runId: ${runId}` }); return }

  const agentName = typeof payload.agent === 'string' ? payload.agent : ''
  const prompt    = typeof payload.prompt === 'string' ? payload.prompt : ''
  if (!agentName || !prompt) {
    sendA2AResult(socket, reqId, { ok: false, error: 'payload.agent and payload.prompt are required' })
    return
  }
  const timeoutMs = typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
    ? payload.timeoutMs : undefined

  const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : undefined
  const inputs = rawInputs?.filter(
    (x): x is Parameters<typeof import('../a2a.js').callAgentByName>[3] extends infer T
      ? T extends { inputs?: (infer U)[] | undefined } ? U : never
      : never =>
      !!x && typeof x === 'object' && !Array.isArray(x)
      && typeof (x as Record<string, unknown>).name === 'string',
  )
  const rawExpect = Array.isArray(payload.expectOutputs) ? payload.expectOutputs : undefined
  const expectOutputs = rawExpect?.filter((s): s is string => typeof s === 'string')

  const { callAgentByName } = await import('../a2a.js')
  const routeCtx = {
    threadId: ctx.threadId,
    channelId: ctx.channelId,
    platform: ctx.platform,
    defaultAgent: agentName,
    traceId: reqId,
    logger: log,
    userId: ctx.userId,
  } as Parameters<typeof callAgentByName>[2]

  const result = await callAgentByName(agentName, prompt, routeCtx, {
    callerAgent: ctx.callerAgent,
    callerDepth: ctx.callDepth ?? 0,
    parentJobId: ctx.parentJobId ?? null,
    ...(ctx.callerPlanMode ? { planMode: true } : {}),
    ...(ctx.onToolActivity ? { onToolActivity: ctx.onToolActivity } : {}),
    timeoutMs,
    ...(inputs && inputs.length > 0 ? { inputs } : {}),
    ...(expectOutputs && expectOutputs.length > 0 ? { expectOutputs } : {}),
  })

  if (result.ok) {
    sendA2AResult(socket, reqId, {
      ok: true, result: result.result, jobId: result.jobId,
      agent: result.agent, durationMs: result.durationMs,
      artifactsDir: result.artifactsDir,
      outputs: result.outputs,
      ...(result.warnings ? { warnings: result.warnings } : {}),
    })
  } else {
    sendA2AResult(socket, reqId, { ok: false, error: result.error })
  }
}

function sendA2AResult(
  socket: Socket,
  reqId: string,
  res:
    | {
        ok: true; result: string; jobId: number; agent: string; durationMs: number
        artifactsDir?: string
        outputs?: Array<{ name: string; bytes: number; mtime: string }>
        warnings?: string[]
      }
    | { ok: false; error: string },
): void {
  if (!socket.writable) return
  const wire: Record<string, unknown> = { v: 1, type: 'a2a.result', reqId, ok: res.ok }
  if (res.ok) {
    wire.result = res.result
    wire.jobId = res.jobId
    wire.agent = res.agent
    wire.durationMs = res.durationMs
    if (res.artifactsDir) wire.artifactsDir = res.artifactsDir
    if (res.outputs && res.outputs.length > 0) wire.outputs = res.outputs
    if (res.warnings && res.warnings.length > 0) wire.warnings = res.warnings
  } else {
    wire.error = res.error
  }
  socket.write(`${JSON.stringify(wire)}\n`, (err) => {
    if (err) log.warn({ event: 'a2a.bus.write_failed', reqId, err: String(err) })
  })
}

// ---------------------------------------------------------------------------
// Reminder
// ---------------------------------------------------------------------------

async function handleReminder(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const op = typeof m.op === 'string' ? m.op : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'reminder.bus.missing_reqId' }); return }
  if (!op) { sendResult(socket, 'reminder.result', reqId, { ok: false, error: 'invalid reminder message' }, 'reminder.bus.write_failed'); return }

  const ctx = resolveRunContext(runId, payload, host, { prefix: 'reminder', allowInlineCtx: true })
  if (!ctx) {
    sendResult(socket, 'reminder.result', reqId, {
      ok: false, error: `unknown runId: ${runId} (and no _im_context fallback provided)`,
    }, 'reminder.bus.write_failed')
    return
  }
  const { handleReminderOp } = await import('../reminder-rpc.js')
  const result = await handleReminderOp(op, payload, ctx)
  sendResult(socket, 'reminder.result', reqId, result, 'reminder.bus.write_failed')
}

// ---------------------------------------------------------------------------
// Memo
// ---------------------------------------------------------------------------

async function handleMemo(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const op = typeof m.op === 'string' ? m.op : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'memo.bus.missing_reqId' }); return }
  if (!op) { sendResult(socket, 'memo.result', reqId, { ok: false, error: 'invalid memo message' }, 'memo.bus.write_failed'); return }

  const ctx = resolveRunContext(runId, payload, host, { prefix: 'memo', allowInlineCtx: true })
  if (!ctx) {
    sendResult(socket, 'memo.result', reqId, {
      ok: false, error: `unknown runId: ${runId} (and no _im_context fallback provided)`,
    }, 'memo.bus.write_failed')
    return
  }
  const { handleMemoOp } = await import('../memo-rpc.js')
  const result = await handleMemoOp(op, payload, ctx)
  sendResult(socket, 'memo.result', reqId, result, 'memo.bus.write_failed')
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function handlePush(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'push.bus.missing_reqId' }); return }
  // _im_context fallback intentionally NOT supported for push (user identity spoofing risk)
  if (payload._im_context) delete payload._im_context
  const ctx = runId ? (host.getRunContext(runId) ?? null) : null
  if (!ctx) {
    sendResult(socket, 'push.result', reqId, {
      ok: false, error: `unknown runId: ${runId} — push requires a live runContext (no _im_context fallback)`,
    }, 'push.bus.write_failed')
    return
  }
  const { handlePushOp } = await import('../push-rpc.js')
  const result = await handlePushOp(payload as import('../push-rpc.js').PushPayload, ctx)
  sendResult(socket, 'push.result', reqId, result, 'push.bus.write_failed')
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

async function handleAsk(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'ask.bus.missing_reqId' }); return }
  if (payload._im_context) delete payload._im_context
  const ctx = runId ? (host.getRunContext(runId) ?? null) : null
  if (!ctx) {
    sendAskResult(socket, reqId, {
      ok: false,
      error: `unknown runId: ${runId} — ask_user requires a live runContext (no _im_context fallback)`,
      reason: 'invalid',
    })
    return
  }
  const { handleAskOp } = await import('../ask-user-rpc.js')
  const result = await handleAskOp(payload as import('../ask-user-rpc.js').AskPayload, ctx)
  sendAskResult(socket, reqId, result)
}

function sendAskResult(
  socket: Socket,
  reqId: string,
  result: import('../ask-user-rpc.js').AskResult,
): void {
  if (!socket.writable) return
  const wire: Record<string, unknown> = { v: 1, type: 'ask.result', reqId, ok: result.ok }
  if (result.ok) wire.result = result.result
  else {
    wire.error = result.error
    if (result.reason) wire.reason = result.reason
  }
  socket.write(`${JSON.stringify(wire)}\n`, (err) => {
    if (err) log.warn({ event: 'ask.bus.write_failed', reqId, err: String(err) })
  })
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

async function handleSkill(
  m: Record<string, unknown>,
  socket: Socket,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'skill.bus.missing_reqId' }); return }
  const { handleSkillsOp } = await import('../skills-rpc.js')
  const result = await handleSkillsOp(payload as import('../skills-rpc.js').SkillsPayload)
  sendSkillResult(socket, reqId, result)
}

function sendSkillResult(
  socket: Socket,
  reqId: string,
  result: import('../skills-rpc.js').SkillsResult,
): void {
  if (!socket.writable) return
  const wire: Record<string, unknown> = { v: 1, type: 'skill.result', reqId, ok: result.ok }
  if (result.ok) wire.result = result.result
  else wire.error = result.error
  socket.write(`${JSON.stringify(wire)}\n`, (err) => {
    if (err) log.warn({ event: 'skill.bus.write_failed', reqId, err: String(err) })
  })
}

// ---------------------------------------------------------------------------
// Native tool
// ---------------------------------------------------------------------------

async function handleNativeTool(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'native_tool.bus.missing_reqId' }); return }
  if (payload._im_context) delete payload._im_context
  if (!runId) {
    sendNativeToolResult(socket, reqId, {
      ok: false, error: 'unknown runId: null — native_tool requires a live runContext',
    })
    return
  }
  const ctx = host.getRunContext(runId) ?? null
  if (!ctx) {
    sendNativeToolResult(socket, reqId, {
      ok: false, error: `unknown runId: ${runId} — native_tool requires a live runContext`,
    })
    return
  }

  const { handleNativeToolOp } = await import('../native-tool-rpc.js')
  try {
    const result = await handleNativeToolOp(payload, {
      reqId,
      runContext: ctx,
      requestApproval: ({ toolName, input }) => new Promise((resolve, reject) => {
        const approvalReqId = `${reqId}:native:${randomUUID()}`
        void host.registerSyntheticPending({
          runId,
          reqId: approvalReqId,
          toolName,
          input,
          ctx,
          dispatch: (decision) => resolve(decision),
        }).catch((err) => reject(err))
      }),
    })
    sendNativeToolResult(socket, reqId, result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendNativeToolResult(socket, reqId, { ok: false, error: `native_tool failed: ${msg}` })
  }
}

function sendNativeToolResult(
  socket: Socket,
  reqId: string,
  result: import('../native-tool-rpc.js').NativeToolRpcResult,
): void {
  if (!socket.writable) return
  const wire: Record<string, unknown> = { v: 1, type: 'native_tool.result', reqId, ok: result.ok }
  if (result.source) wire.source = result.source
  if (result.ok) wire.result = result.result
  else wire.error = result.error
  socket.write(`${JSON.stringify(wire)}\n`, (err) => {
    if (err) log.warn({ event: 'native_tool.bus.write_failed', reqId, err: String(err) })
  })
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

async function handleMemory(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const op = typeof m.op === 'string' ? m.op : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'memory.bus.missing_reqId' }); return }
  if (!op) {
    sendResult(socket, 'memory.result', reqId, { ok: false, error: 'invalid memory message (op missing)' }, 'memory.bus.write_failed')
    return
  }
  // _im_context NOT supported: memory is scoped by userId (spoofing risk)
  if (payload._im_context) delete payload._im_context
  const ctx = runId ? (host.getRunContext(runId) ?? null) : null
  if (!ctx) {
    sendResult(socket, 'memory.result', reqId, {
      ok: false, error: `unknown runId: ${runId} — memory ops require a live runContext (no _im_context fallback)`,
    }, 'memory.bus.write_failed')
    return
  }
  const { handleMemoryOp } = await import('../memory-rpc.js')
  const result = await handleMemoryOp(op, payload, ctx)
  sendResult(socket, 'memory.result', reqId, result, 'memory.bus.write_failed')
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

async function handleGoal(
  m: Record<string, unknown>,
  socket: Socket,
  host: ApprovalRpcHost,
): Promise<void> {
  const reqId = typeof m.reqId === 'string' ? m.reqId : null
  const runId = typeof m.runId === 'string' ? m.runId : null
  const op = typeof m.op === 'string' ? m.op : null
  const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
    ? m.payload as Record<string, unknown>
    : {}

  if (!reqId) { log.warn({ event: 'goal.bus.missing_reqId' }); return }
  if (!op || (op !== 'long_task' && op !== 'complete_goal')) {
    sendResult(socket, 'goal.result', reqId, {
      ok: false, error: 'invalid goal message (op must be long_task|complete_goal)',
    }, 'goal.bus.write_failed')
    return
  }
  const ctx = runId ? (host.getRunContext(runId) ?? null) : null
  if (!ctx) {
    sendResult(socket, 'goal.result', reqId, {
      ok: false, error: `unknown runId: ${runId} — goal ops require a live runContext`,
    }, 'goal.bus.write_failed')
    return
  }
  const { handleGoalOp } = await import('../goal-rpc.js')
  const { hashWorkspaceScope } = await import('../goal-evidence.js')
  const { defaultAgentCwd, resolveAgentCwd } = await import('../agent-cwd.js')
  const agentName = ctx.callerAgent || 'agim'
  const result = await handleGoalOp(op, payload, {
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    userId: ctx.userId,
    callerAgent: ctx.callerAgent,
    traceId: ctx.traceId,
    workspaceScope: hashWorkspaceScope(
      resolveAgentCwd(agentName, {
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
      }) || defaultAgentCwd(agentName),
    ),
  })
  sendResult(socket, 'goal.result', reqId, result, 'goal.bus.write_failed')
}
