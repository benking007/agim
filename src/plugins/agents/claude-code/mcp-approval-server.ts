// MCP sidecar — Claude Code 通过 --permission-prompt-tool 调用本进程的 `request` 工具，
// 本进程把请求转发给 agim 主进程的 approval-bus（unix socket），等用户决策回包后
// 翻译成 MCP tool result。
//
// 这是个独立进程，由 claude 子进程通过 --mcp-config 启动；与 agim 通信只走 socket。
// 启动需要两个 env：
//   AGIM_APPROVAL_SOCK  unix socket 路径
//   AGIM_RUN_ID         本次 claude run 的 ID（与 approvalBus.registerRun 配套）
//
// 协议见 src/core/approval-bus.ts。
//
// 入口（编译后）：node dist/plugins/agents/claude-code/mcp-approval-server.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  CALL_AGENTS_TASKS_HARD_MAX,
  getSubagentParallelMax,
  isSubagentParallelEnabled,
  mapPool,
} from '../../../core/subagent-parallel.js'

const SERVER_NAME = 'agim'
const TOOL_NAME = 'request'

interface DecisionAllow { behavior: 'allow'; updatedInput?: Record<string, unknown> }
interface DecisionDeny { behavior: 'deny'; message?: string }
type Decision = DecisionAllow | DecisionDeny

interface PendingRequest {
  resolve: (d: Decision) => void
  /** Original tool input — needed to echo back as updatedInput on allow,
   *  since Claude Code rejects an allow response that lacks updatedInput. */
  originalInput: Record<string, unknown>
}

interface ReminderResult {
  ok: boolean
  result?: unknown
  error?: string
}

interface PendingReminderRpc {
  resolve: (r: ReminderResult) => void
}

// Location RPC mirrors reminder RPC — same shape, separate result map so
// reminder + location can be in flight concurrently without reqId collision
// risk (in practice reqIds are UUIDs, but keeping channels separate is
// simpler than reasoning about the shared map).
type MemoResult = ReminderResult
type PendingMemoRpc = PendingReminderRpc

// A2A-L1 — Agent-to-Agent call result. Unlike reminder/memo, the wire
// carries explicit jobId/agent/durationMs on success so the caller agent
// can include them in its response to the user.
// L2 fields are optional on the wire — old (L1-only) bus responses
// simply omit them. The wire envelope is otherwise unchanged.
type A2aOutputFile = { name: string; bytes: number; mtime: string }
type A2aSuccess = {
  ok: true
  result: string
  jobId: number
  agent: string
  durationMs: number
  artifactsDir?: string
  outputs?: A2aOutputFile[]
  warnings?: string[]
}
type A2aFailure = { ok: false; error: string }
type A2aResult = A2aSuccess | A2aFailure
interface PendingA2aRpc { resolve: (r: A2aResult) => void }

// v1.3 — push_message RPC: agent-initiated message to an IM thread.
// Wire success result is { outboxId, immediate, targetThread }.
type PushResult = ReminderResult
type PendingPushRpc = PendingReminderRpc

// v1.5 — long-term memory RPC (memory_query / save / list / delete).
type MemoryResult = ReminderResult
type PendingMemoryRpc = PendingReminderRpc

// P0 #5 — ask_user RPC: agent asks the user a structured multi-choice
// question and waits for the reply. Wire success is { index, label,
// via:'button'|'text', raw }; failure carries an optional reason
// ('timeout' | 'cancelled' | 'invalid' | 'no-messenger').
interface AskOk {
  ok: true
  result: {
    index: number
    label: string
    via: 'button' | 'text'
    raw: string
    selectionMode?: 'single' | 'multi'
    indexes?: number[]
    labels?: string[]
    customText?: string
  }
}
interface AskFail { ok: false; error: string; reason?: 'timeout' | 'cancelled' | 'invalid' | 'no-messenger' }
type AskResult = AskOk | AskFail
interface PendingAskRpc { resolve: (r: AskResult) => void }

// Stage 3 / P0 #3 — skills loader RPC (read / list / refresh).
type SkillResult = ReminderResult
type PendingSkillRpc = PendingReminderRpc

// Native tool bridge (web/search plus approval-gated bash/write/edit). Same
// wire result shape as reminder/memo; separate pending map keeps channels
// independent when a tool call and a memo write happen concurrently.
type NativeToolResult = ReminderResult
type PendingNativeToolRpc = PendingReminderRpc

class ApprovalClient {
  private socket: Socket | null = null
  private buf = ''
  private pending = new Map<string, PendingRequest>()
  private pendingReminders = new Map<string, PendingReminderRpc>()
  private pendingMemos = new Map<string, PendingMemoRpc>()
  private pendingA2A = new Map<string, PendingA2aRpc>()
  private pendingPush = new Map<string, PendingPushRpc>()
  private pendingMemory = new Map<string, PendingMemoryRpc>()
  private pendingAsk = new Map<string, PendingAskRpc>()
  private pendingSkill = new Map<string, PendingSkillRpc>()
  private pendingNativeTools = new Map<string, PendingNativeToolRpc>()
  private connectErr: Error | null = null
  private closed = false
  private connectPromise: Promise<void>

  constructor(private readonly socketPath: string, private readonly runId: string) {
    this.connectPromise = this.connect()
  }

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const sock = createConnection(this.socketPath)
      sock.setEncoding('utf8')

      const onConnectError = (err: Error): void => {
        this.connectErr = err
        this.closed = true
        // stderr surfaces inside Claude Code's MCP log
        process.stderr.write(`[mcp-approval-server] connect failed: ${err.message}\n`)
        resolve()
      }
      sock.once('error', onConnectError)
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError)
        sock.on('error', (err) => {
          process.stderr.write(`[mcp-approval-server] socket error: ${err.message}\n`)
        })
        sock.on('data', (chunk: string) => this.onData(chunk))
        sock.on('close', () => this.onClose())
        this.socket = sock
        resolve()
      })
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    while (true) {
      const nl = this.buf.indexOf('\n')
      if (nl === -1) break
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: unknown
      try { msg = JSON.parse(line) } catch {
        process.stderr.write(`[mcp-approval-server] bad json from bus: ${line.slice(0, 200)}\n`)
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    if (m.v !== 1) return

    if (m.type === 'decision') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pending.get(reqId)
      if (!p) return
      this.pending.delete(reqId)
      if (m.behavior === 'allow') {
        const updatedInput = (m.updatedInput && typeof m.updatedInput === 'object' && !Array.isArray(m.updatedInput))
          ? m.updatedInput as Record<string, unknown>
          : p.originalInput   // Claude Code requires updatedInput; echo original
        p.resolve({ behavior: 'allow', updatedInput })
      } else {
        const message = typeof m.message === 'string' ? m.message : undefined
        p.resolve({ behavior: 'deny', ...(message ? { message } : {}) })
      }
      return
    }

    if (m.type === 'reminder.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingReminders.get(reqId)
      if (!p) return
      this.pendingReminders.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }

    if (m.type === 'memo.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingMemos.get(reqId)
      if (!p) return
      this.pendingMemos.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }

    if (m.type === 'push.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingPush.get(reqId)
      if (!p) return
      this.pendingPush.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }

    if (m.type === 'ask.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingAsk.get(reqId)
      if (!p) return
      this.pendingAsk.delete(reqId)
      if (m.ok === true && m.result && typeof m.result === 'object') {
        const r = m.result as Record<string, unknown>
        const idx = typeof r.index === 'number' ? r.index : NaN
        const label = typeof r.label === 'string' ? r.label : ''
        const via = (r.via === 'button' || r.via === 'text') ? r.via : 'text'
        const raw = typeof r.raw === 'string' ? r.raw : ''
        if (Number.isFinite(idx) && label) {
          p.resolve({ ok: true, result: { index: idx, label, via, raw } })
        } else {
          p.resolve({ ok: false, error: 'malformed ask.result payload' })
        }
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        const reason = typeof m.reason === 'string' ? m.reason as AskFail['reason'] : undefined
        const failure: AskFail = { ok: false, error }
        if (reason) failure.reason = reason
        p.resolve(failure)
      }
      return
    }

    if (m.type === 'memory.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingMemory.get(reqId)
      if (!p) return
      this.pendingMemory.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }

    if (m.type === 'skill.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingSkill.get(reqId)
      if (!p) return
      this.pendingSkill.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }

    if (m.type === 'native_tool.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingNativeTools.get(reqId)
      if (!p) return
      this.pendingNativeTools.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }

    if (m.type === 'a2a.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingA2A.get(reqId)
      if (!p) return
      this.pendingA2A.delete(reqId)
      if (m.ok === true
          && typeof m.result === 'string'
          && typeof m.jobId === 'number'
          && typeof m.agent === 'string'
          && typeof m.durationMs === 'number') {
        // L2 fields are optional; ignore them on the wire if the bus
        // happens to be older. Type-narrow defensively before forwarding.
        const success: A2aSuccess = {
          ok: true, result: m.result, jobId: m.jobId,
          agent: m.agent, durationMs: m.durationMs,
        }
        if (typeof m.artifactsDir === 'string') success.artifactsDir = m.artifactsDir
        if (Array.isArray(m.outputs)) {
          const files: A2aOutputFile[] = []
          for (const o of m.outputs) {
            if (o && typeof o === 'object'
                && typeof (o as Record<string, unknown>).name === 'string'
                && typeof (o as Record<string, unknown>).bytes === 'number'
                && typeof (o as Record<string, unknown>).mtime === 'string') {
              files.push(o as A2aOutputFile)
            }
          }
          if (files.length > 0) success.outputs = files
        }
        if (Array.isArray(m.warnings)) {
          const warns = m.warnings.filter((w): w is string => typeof w === 'string')
          if (warns.length > 0) success.warnings = warns
        }
        p.resolve(success)
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }
  }

  private onClose(): void {
    this.closed = true
    // Drain pending with deny — claude is left hanging otherwise
    for (const [, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'approval bus disconnected' })
    }
    this.pending.clear()
    for (const [, p] of this.pendingReminders) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingReminders.clear()
    for (const [, p] of this.pendingMemos) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingMemos.clear()
    for (const [, p] of this.pendingA2A) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingA2A.clear()
    for (const [, p] of this.pendingPush) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingPush.clear()
    for (const [, p] of this.pendingMemory) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingMemory.clear()
    for (const [, p] of this.pendingAsk) {
      p.resolve({ ok: false, error: 'approval bus disconnected', reason: 'cancelled' })
    }
    this.pendingAsk.clear()
    for (const [, p] of this.pendingSkill) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingSkill.clear()
    for (const [, p] of this.pendingNativeTools) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingNativeTools.clear()
  }

  // request(): see below — request → register pending → write payload

  /**
   * Send an approval request and wait for the decision. If the bus is
   * unreachable or the connection has dropped, returns a deny synchronously.
   */
  async request(args: {
    toolName: string
    input: Record<string, unknown>
    toolUseId: string
  }): Promise<Decision> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { behavior: 'deny', message: `approval bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const payload = `${JSON.stringify({
      v: 1,
      type: 'approval',
      runId: this.runId,
      reqId,
      toolName: args.toolName,
      input: args.input,
      toolUseId: args.toolUseId,
    })}\n`

    return new Promise<Decision>((resolve) => {
      this.pending.set(reqId, { resolve, originalInput: args.input })
      this.socket?.write(payload, (err) => {
        if (err) {
          this.pending.delete(reqId)
          resolve({ behavior: 'deny', message: `write failed: ${err.message}` })
        }
      })
    })
  }

  /**
   * Send a reminder RPC and wait for the result. Same socket as approvals,
   * different message type. Bus delegates to reminder-rpc.ts which actually
   * touches reminders.db.
   */
  async requestReminder(op: string, payload: Record<string, unknown>): Promise<ReminderResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'reminder',
      runId: this.runId,
      reqId,
      op,
      payload,
    })}\n`
    return new Promise<ReminderResult>((resolve) => {
      this.pendingReminders.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingReminders.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /** Stage 3 / P0 #3 — skills loader RPC. op ∈ 'read'|'list'|'refresh'. */
  async requestSkill(op: string, payload: Record<string, unknown>): Promise<SkillResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1, type: 'skill', reqId, payload: { op, ...payload },
    })}\n`
    return new Promise<SkillResult>((resolve) => {
      this.pendingSkill.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingSkill.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /**
   * Native tool bridge for MCP-only agents. The bus resolves runId → IM
   * context, asks the user to approve mutation tools, then dispatches the
   * native implementation inside Agim.
   */
  async requestNativeTool(name: string, args: Record<string, unknown>): Promise<NativeToolResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    if (!this.runId) {
      return { ok: false, error: 'AGIM_RUN_ID is not set; native tools require a live run context' }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'native_tool',
      runId: this.runId,
      reqId,
      payload: { name, arguments: args },
    })}\n`
    return new Promise<NativeToolResult>((resolve) => {
      this.pendingNativeTools.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingNativeTools.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

    /** v1.5 — long-term memory ops via approval-bus. */
  async requestMemory(op: string, payload: Record<string, unknown>): Promise<MemoryResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1, type: 'memory', runId: this.runId, reqId, op, payload,
    })}\n`
    return new Promise<MemoryResult>((resolve) => {
      this.pendingMemory.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingMemory.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /** v1.3 — agent-initiated push to an IM thread. */
  async requestPush(payload: Record<string, unknown>): Promise<PushResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'push',
      runId: this.runId,
      reqId,
      payload,
    })}\n`
    return new Promise<PushResult>((resolve) => {
      this.pendingPush.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingPush.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /** P0 #5 — agent asks the user a question, waits for the reply. */
  async requestAsk(payload: Record<string, unknown>): Promise<AskResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'ask',
      runId: this.runId,
      reqId,
      payload,
    })}\n`
    return new Promise<AskResult>((resolve) => {
      this.pendingAsk.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingAsk.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /** Same shape as requestReminder, different message type. Bus delegates
   *  to memo-rpc.ts which actually writes memos.db. */
  async requestMemo(op: string, payload: Record<string, unknown>): Promise<MemoResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'memo',
      runId: this.runId,
      reqId,
      op,
      payload,
    })}\n`
    return new Promise<MemoResult>((resolve) => {
      this.pendingMemos.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingMemos.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /** A2A — ask the bus to invoke another agent. Bus resolves the
   *  caller via runId → RunContext, validates depth + self-call, runs
   *  the callee via a2a.callAgentByName, and writes back the result.
   *
   *  L2 additions (all optional):
   *    inputs        — file payloads dropped into the callee's
   *                    _agim-input/ before it runs.
   *    expectOutputs — filenames the callee is expected to produce;
   *                    misses become warnings, not failures. */
  async requestCallAgent(payload: {
    agent: string
    prompt: string
    timeoutMs?: number
    inputs?: Array<
      | { name: string; fromCallerOutput: string }
      | { name: string; fromAbsolutePath: string }
      | { name: string; content: string }
    >
    expectOutputs?: string[]
  }): Promise<A2aResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1, type: 'a2a',
      runId: this.runId, reqId,
      payload,
    })}\n`
    return new Promise<A2aResult>((resolve) => {
      this.pendingA2A.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingA2A.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /**
   * Parallel / serial fan-out of independent A2A lanes (CLI Subagent dispatch).
   * Reuses the same `a2a` bus path as `requestCallAgent`; join is allSettled-style.
   * Loop parent tools (`loop_verdict` / Focus) stay Agim-only — not exposed here.
   */
  async requestCallAgents(
    tasks: Array<{
      agent: string
      prompt: string
      timeoutMs?: number
      inputs?: Parameters<ApprovalClient['requestCallAgent']>[0]['inputs']
      expectOutputs?: string[]
    }>,
  ): Promise<{
    ok: true
    parallel: boolean
    concurrency: number
    okCount: number
    lanes: Array<
      | {
          ok: true
          index: number
          agent: string
          jobId: number
          durationMs: number
          result: string
          artifactsDir?: string
          outputs?: A2aOutputFile[]
          warnings?: string[]
        }
      | { ok: false; index: number; agent: string; error: string }
    >
  } | { ok: false; error: string }> {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { ok: false, error: 'call_agents requires a non-empty `tasks` array.' }
    }
    if (tasks.length > CALL_AGENTS_TASKS_HARD_MAX) {
      return {
        ok: false,
        error:
          `call_agents refused: tasks.length=${tasks.length} exceeds hard max ${CALL_AGENTS_TASKS_HARD_MAX}.`,
      }
    }
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      if (!t || typeof t !== 'object') {
        return { ok: false, error: `call_agents tasks[${i}] must be an object.` }
      }
      if (typeof t.agent !== 'string' || !t.agent.trim() || typeof t.prompt !== 'string' || !t.prompt.trim()) {
        return { ok: false, error: `call_agents tasks[${i}] requires both agent and prompt strings.` }
      }
    }

    const parallelOn = isSubagentParallelEnabled()
    const concurrency = parallelOn ? Math.min(getSubagentParallelMax(), tasks.length) : 1
    const lanes = await mapPool(tasks, concurrency, async (task, index) => {
      const r = await this.requestCallAgent({
        agent: task.agent.trim(),
        prompt: task.prompt,
        ...(typeof task.timeoutMs === 'number' ? { timeoutMs: task.timeoutMs } : {}),
        ...(task.inputs ? { inputs: task.inputs } : {}),
        ...(task.expectOutputs ? { expectOutputs: task.expectOutputs } : {}),
      })
      if (r.ok) {
        return {
          ok: true as const,
          index,
          agent: r.agent,
          jobId: r.jobId,
          durationMs: r.durationMs,
          result: r.result,
          ...(r.artifactsDir ? { artifactsDir: r.artifactsDir } : {}),
          ...(r.outputs ? { outputs: r.outputs } : {}),
          ...(r.warnings ? { warnings: r.warnings } : {}),
        }
      }
      return {
        ok: false as const,
        index,
        agent: task.agent.trim(),
        error: r.error,
      }
    })
    const okCount = lanes.filter((l) => l.ok).length
    return { ok: true, parallel: parallelOn, concurrency, okCount, lanes }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.socket && !this.socket.destroyed) {
      await new Promise<void>((resolve) => {
        this.socket?.once('close', () => resolve())
        this.socket?.end()
        setTimeout(() => { if (this.socket && !this.socket.destroyed) this.socket.destroy() }, 200).unref()
      })
    }
  }
}

/**
 * Build the MCP server. Exposed as a function (rather than top-level `await`)
 * so tests can construct it without spinning up stdio.
 */
export function buildServer(client: ApprovalClient): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '0.1.0',
  })

  // Accept both snake_case (what Claude Code sends over the wire) and
  // camelCase (defensive — some forks normalize). passthrough so unknown
  // future fields are not stripped before we see them.
  const inputSchema = {
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    tool_use_id: z.string().optional(),
    toolUseId: z.string().optional(),
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: 'IM hub permission prompt',
      description:
        'Routes Claude Code permission prompts to agim for human approval over IM. ' +
        'Returns {behavior: "allow"|"deny", ...} as a JSON-encoded text block.',
      inputSchema,
    },
    async (args) => {
      const toolName = args.tool_name ?? args.toolName ?? '<unknown>'
      const input = (args.input ?? {}) as Record<string, unknown>
      const toolUseId = args.tool_use_id ?? args.toolUseId ?? ''

      // Auto-allow agim's own MCP tools. These are user-scoped, idempotent,
      // and easily reversible via /remind cancel — asking the user to
      // approve "do you really want this reminder you literally just asked
      // for" is double-confirmation and clutters the chat. The tool body
      // itself runs through bus.handleReminder which validates payloads.
      if (toolName.startsWith('mcp__agim__')) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ behavior: 'allow', updatedInput: input }),
            },
          ],
        }
      }

      const decision = await client.request({ toolName, input, toolUseId })
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(decision) },
        ],
      }
    },
  )

  // ─── Reminder tools ───────────────────────────────────────────────
  // These let Claude create / list / cancel / snooze reminders for the
  // current IM user without going back to the user with a slash command.
  // Bus uses runId → RunContext to know which user/thread the call belongs
  // to. All four tools return JSON-encoded text blocks; the result schema
  // is `{ok: true, result: {...}} | {ok: false, error: string}`.
  //
  // `_im_context` is a single-user fallback for adapter setups where the
  // MCP server is shared (e.g. opencode http daemon — see ensure-mcp-config.ts):
  // the runId env var was set when opencode serve started and is the SAME
  // for all sessions, so we can't disambiguate via runId. Instead the agent
  // is instructed (via prompt injection) to pass an `_im_context` block,
  // which the bus uses iff the runId lookup fails. Untrusted in multi-user
  // deployments — operators must understand the trust model.

  const imContextSchema = z.object({
    platform: z.string(),
    threadId: z.string(),
    channelId: z.string(),
    userId: z.string().optional(),
  }).optional().describe(
    'IM context override. Only set this when the system prompt explicitly tells you to. ' +
    'Otherwise omit and the server figures it out via runId.',
  )

  const wrapReminder = (op: string) => async (args: Record<string, unknown>) => {
    const result = await client.requestReminder(op, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  }
  const wrapMemo = (op: string) => async (args: Record<string, unknown>) => {
    const result = await client.requestMemo(op, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  }
  const wrapNativeTool = (name: string) => async (args: Record<string, unknown>) => {
    const result = await client.requestNativeTool(name, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  }

  // ─── Native tools via Agim approval ───────────────────────────────
  // MCP-only agents (Kimi/Qoder/PI-style integrations) do not expose their
  // own permission prompts through Agim. These tools provide the Agim-owned
  // path instead: mutation calls create an IM approval card first, and only
  // execute after the user allows them.
  server.registerTool(
    'agim_bash',
    {
      title: 'Run a shell command after Agim approval',
      description:
        'Run a shell command through Agim. This requires user approval before execution. ' +
        'Use this instead of native Bash / terminal tools when operating from IM.',
      inputSchema: {
        command: z.string().min(1).describe('Shell command to execute.'),
        timeout_ms: z.number().int().positive().optional().describe('Optional timeout in milliseconds.'),
        cwd: z.string().optional().describe('Optional working directory. Defaults to the agent workspace.'),
      },
    },
    wrapNativeTool('agim_bash'),
  )

  server.registerTool(
    'agim_write',
    {
      title: 'Write a file after Agim approval',
      description:
        'Write or append a UTF-8 file through Agim. This requires user approval before execution. ' +
        'Use this instead of native Write / edit tools when operating from IM.',
      inputSchema: {
        path: z.string().min(1).describe('File path to write. Relative paths resolve in the agent workspace.'),
        content: z.string().describe('UTF-8 content to write.'),
        mode: z.enum(['overwrite', 'append']).optional().describe('Default overwrite; append adds to the end.'),
      },
    },
    wrapNativeTool('agim_write'),
  )

  server.registerTool(
    'agim_edit',
    {
      title: 'Edit a file after Agim approval',
      description:
        'Perform an exact string replacement through Agim. This requires user approval before execution. ' +
        'Use this instead of native Edit / write tools when operating from IM.',
      inputSchema: {
        path: z.string().min(1).describe('File path to edit. Relative paths resolve in the agent workspace.'),
        old_string: z.string().min(1).describe('Exact text to replace.'),
        new_string: z.string().describe('Replacement text.'),
        replace_all: z.boolean().optional().describe('Replace all occurrences. Default false.'),
      },
    },
    wrapNativeTool('agim_edit'),
  )

  server.registerTool(
    'create_reminder',
    {
      title: 'Create a reminder',
      description:
        'Create a one-shot or recurring reminder for the current user. CALL THIS PROACTIVELY ' +
        'whenever the user mentions a future commitment, event, task, or anything they might ' +
        'want to be reminded about — including casual mentions like "明天中午要开会", ' +
        '"下周三去医院复查", or explicit asks like "提醒我30分钟后喝水". ' +
        'The reminder will fire at fireAt and be delivered to this same IM thread. ' +
        'After creating, briefly acknowledge to the user (e.g. "✅ 已为你设了提醒，明天12点 团队聚餐"). ' +
        'For recurring: use "every:5m", "daily:08:00", or "weekly:1,3,5:09:00". ' +
        'High-frequency (interval < 1h) + LLM polish is auto-confirmed via card; ' +
        'agent should keep its reply terse in that case.',
      inputSchema: {
        fireAt: z.string().describe('First fire time as ISO 8601 local-time, e.g. "2026-05-10T12:00:00"'),
        text: z.string().describe('What to remind the user about, ≤ 60 chars. Just the activity, not the time.'),
        recurrence: z.string().optional().describe('Optional. "every:5m" | "daily:HH:MM" | "weekly:1,3,5:HH:MM"'),
        promptMode: z.enum(['literal', 'llm']).optional().describe(
          'Default "llm" (LLM polishes the reminder text at fire time). Pass "literal" for verbatim delivery.',
        ),
        _im_context: imContextSchema,
      },
    },
    wrapReminder('create'),
  )

  server.registerTool(
    'list_reminders',
    {
      title: 'List reminders',
      description:
        'List the current user\'s pending reminders. Use this when the user asks "我有什么提醒" / ' +
        '"接下来要做什么" or before suggesting cancel/snooze.',
      inputSchema: { _im_context: imContextSchema },
    },
    wrapReminder('list'),
  )

  server.registerTool(
    'cancel_reminder',
    {
      title: 'Cancel a reminder',
      description:
        'Cancel a pending reminder by id. Find ids via list_reminders. For recurring reminders, ' +
        'this terminates the entire loop.',
      inputSchema: {
        id: z.number().int().positive().describe('Reminder id from list_reminders'),
        _im_context: imContextSchema,
      },
    },
    wrapReminder('cancel'),
  )

  server.registerTool(
    'snooze_reminder',
    {
      title: 'Snooze a reminder',
      description:
        'Push a reminder back by a duration ("5m", "30m", "2h"). Creates a new reminder with the ' +
        'same text and cancels the original.',
      inputSchema: {
        id: z.number().int().positive().describe('Reminder id to snooze'),
        duration: z.string().describe('Duration like "5m" / "30m" / "2h" / "1d"'),
        _im_context: imContextSchema,
      },
    },
    wrapReminder('snooze'),
  )

  // ─── Memo tools (5W1H persistent memory) ─────────────────────────────
  // Generalized "记下来" memory database. Each memo carries optional 5W1H
  // fields — what (REQUIRED), who, when_at/when_text, where_lat/lng/label,
  // how, why. Plus expires_at (NULL = permanent). Five tools:
  //
  //   save_memo                  agent extracts whatever 5W1H it can from
  //                              the user's natural language and persists.
  //   request_location_capture   one-time HTTPS link for browser GPS;
  //                              creates a NEW memo OR augments an
  //                              existing memo's where_*. Result delivery
  //                              is async — agim pushes "✅ 已记下..."
  //                              to the IM thread once coords arrive.
  //   search_memos               recall: free-text + structured filters.
  //   update_memo                patch an existing memo when user adds
  //                              context after the initial save.
  //   delete_memo                drop one memo by id.

  server.registerTool(
    'save_memo',
    {
      title: 'Save a memo (5W1H persistent record)',
      description:
        'Record any kind of memo for the user — "请记下" / "帮我记一下" / "别忘了" / "重要的事". ' +
        'Extract 5W1H from the user\'s message: what (the core thing — REQUIRED), who (person/org), ' +
        'when_at (parseable datetime) or when_text (raw phrase if not parseable), where_lat/lng + ' +
        'where_label OR address (server geocodes), how (manner), why (reason). Examples:\n' +
        '  "我爸爸的生日是5月8日"      → { what: "生日", who: "爸爸", when_text: "5月8日" }\n' +
        '  "明天下午3点开会"           → { what: "开会", when_at: "<2026-05-11 15:00:00>" }\n' +
        '  "我朋友的茶馆在 X 路 Y 号" → { what: "茶馆", who: "朋友", address: "X路Y号" } [PERMANENT]\n' +
        '  "苹果今年发了AVP2"          → { what: "AVP2", who: "苹果" }\n' +
        '  "国贸三期是公司新址"        → { what: "公司新址", address: "国贸三期" } (geocoded)\n' +
        '  "我把车停在地下B区了"       → DO NOT call save_memo — use request_location_capture\n\n' +
        '⏰ TIMEZONE: ALL times are interpreted as Asia/Shanghai (UTC+8). When the user says "明天" ' +
        '"下午3点" "下周" etc., compute the absolute datetime in UTC+8 and format as ' +
        '"YYYY-MM-DD HH:MM:SS" (no T, no offset suffix — bare local). Do NOT use ISO with `Z` or ' +
        '`+00:00` — that would store UTC and display 8h off in CN. Server normalizes "+08:00" / "Z" ' +
        'inputs to local for safety, but emit local directly.\n\n' +
        '⚠️ EXPIRY (this is subtle — read carefully):\n' +
        'Default = PERMANENT. Only set expires_in_hours when the memo is genuinely transient. ' +
        'The signal is the SEMANTICS of the user\'s words, NOT whether the memo has location.\n\n' +
        '  TRANSIENT (set expires_in_hours):\n' +
        '   • "刚刚 / 刚才 / 暂时 / 临时 / 今天 / 这次" + 状态描述\n' +
        '   • "我把车停在这了" (parking — typically 24)\n' +
        '   • "我把伞放在前台了" (today\'s ad-hoc placement — 24)\n' +
        '   • "今天的会议在 3 楼" (one-day-relevant — 24)\n\n' +
        '  PERMANENT (omit expires_in_hours):\n' +
        '   • "X 是我朋友常去的茶馆" / "X 是我们老地方" → 永久存（即使有 location！）\n' +
        '   • "我家在 X" / "我公司在 Y" → 永久\n' +
        '   • "爸爸生日是..." / "妈妈电话是..." → 永久\n' +
        '   • Anything user explicitly says "永久 / 记住 / 总是 / 重要" → 永久\n\n' +
        'When ambiguous, ASK the user: "这个要永久记还是 24h 后忘掉？" then use the answer. ' +
        'NEVER guess "transient" just because there\'s a location — friends\' regular hangouts, ' +
        'home/office addresses, favorite places are all permanent.\n\n' +
        'IF the user wants to record their CURRENT GPS location ("我把车停这" / "记一下我现在 ' +
        '的位置"), DO NOT call save_memo — call request_location_capture instead (it can take a ' +
        '`what` arg to label the new memo at capture time).\n\n' +
        '📍 LOCATION ANNOTATION (Telegram / Feishu native pin or venue share):\n' +
        'If the user\'s message STARTS with a tag like\n' +
        '  [user just shared location: lat=30.27, lng=120.12, name="黄龙国际中心", address="学院路77号", accuracy_m=5]\n' +
        '...the adapter received a native GPS pin and stashed the coords here. The follow-up text\n' +
        'after the annotation is the user\'s actual instruction. Common patterns:\n' +
        '  • "记下/记一下/帮我记 X" → save_memo({what: <extract from text>, where_lat, where_lng,\n' +
        '    where_label: <name + address if both present, joined by " · ">})\n' +
        '  • "这是我公司/家/...的地方" → save_memo(same — use the noun the user named)\n' +
        '  • "这是哪里？" → answer the question; the venue name/address in the annotation IS the\n' +
        '    answer. No save_memo needed.\n' +
        '  • "不用" / silence on a new topic → ignore the location, just respond.\n' +
        'DO NOT call request_location_capture here — the coords are ALREADY provided. Use lat/lng\n' +
        'from the annotation directly via where_lat/where_lng. Do NOT echo the raw annotation\n' +
        'back to the user; it\'s for you, not them.\n\n' +
        '🧭 PROACTIVE FOLLOW-UP for place-like memos:\n' +
        'When the memo what is clearly a PLACE (家/公司/茶馆/餐厅/酒店/朋友的工作室/老孙家 ' +
        'etc.) AND the user did NOT supply where_lat/lng/address, AFTER saving, ASK ONE short ' +
        'clarifying question, e.g.:\n' +
        '  "记下了 ✅ 老孙家（常聚会的地方），永久保存。\n' +
        '   要不要顺带补个坐标？\n' +
        '   • 我现在就在那 → 抓 GPS\n' +
        '   • 告诉你地址 → 帮你解析\n' +
        '   • 不用了"\n' +
        'Then route the answer into the right tool (see "TOOL INVENTORY" below).\n' +
        'Skip this for non-place memos (生日 / 联系方式 / 新闻条目 / preferences / 任何抽象事物).\n\n' +
        '🧰 TOOL INVENTORY (you have these RIGHT NOW — do NOT tell the user any of them is gone):\n' +
        '  • save_memo with `address` arg — geocode + save in one shot (this tool, address path)\n' +
        '  • request_location_capture({what?, memo_id?}) — GPS via H5 link\n' +
        '       - {what} → creates a new memo at capture time\n' +
        '       - {memo_id} → AUGMENTS an existing memo (use this to fill where_* on a memo\n' +
        '         you already saved without coords)\n' +
        '  • update_memo({id, address}) — geocode + patch existing memo\'s where_*\n' +
        '  • update_memo({id, where_lat, where_lng, where_label}) — patch directly\n\n' +
        'Returns the saved memo summary including id, fields, and (if where_* set) mapUrls. ' +
        'Confirm to the user with one sentence + (if where_* set) the map links using markdown ' +
        '`[百度地图](url) · [高德地图](url) · [Google](url)`. Do NOT print raw URLs.',
      inputSchema: {
        what: z.string().describe('Core thing being recorded (REQUIRED). ≤200 chars'),
        who: z.string().optional().describe('Person/org/role involved (e.g. "爸爸", "团队")'),
        when_at: z.string().optional().describe('Asia/Shanghai (UTC+8) datetime, format "YYYY-MM-DD HH:MM:SS" (no T, no offset)'),
        when_text: z.string().optional().describe('Raw user phrase if when_at not parseable, e.g. "明年5月" / "下个月底"'),
        where_lat: z.number().min(-90).max(90).optional().describe('WGS-84 latitude (pair with where_lng)'),
        where_lng: z.number().min(-180).max(180).optional().describe('WGS-84 longitude'),
        where_label: z.string().optional().describe('Place name / address text'),
        address: z.string().optional().describe('Free-text address — geocoded server-side via Baidu when where_lat/lng absent'),
        how: z.string().optional().describe('Manner / process'),
        why: z.string().optional().describe('Reason / motivation'),
        memo: z.string().optional().describe(
          'Free-text full intent — preserves the user\'s complete phrasing when `what` is a ' +
          'shorter extracted noun. Set this when the user said something longer than the noun ' +
          'you captured in `what` (e.g. what="车", memo="我车暂时停这里，晚点过来取"). ' +
          'Searchable via search_memos query. Omit when `what` already captures the full intent.',
        ),
        expires_in_hours: z.number().positive().optional().describe('Auto-expire in N hours. Omit for permanent.'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('save'),
  )

  server.registerTool(
    'request_location_capture',
    {
      title: 'Get user\'s current device GPS via one-time link',
      description:
        'Generate a one-time HTTPS link that opens a page asking for browser geolocation. ' +
        'CALL THIS when the user wants to record where they ARE RIGHT NOW: "我把车停这了" / ' +
        '"记一下我现在的位置" / "伞放这儿了，记一下". Two modes:\n\n' +
        '  1. Create new memo (pass `what`): the H5 callback creates a fresh memo with ' +
        '     where_lat/lng + the what label. Use when this is the first time the topic is ' +
        '     being captured.\n' +
        '  2. Update existing memo (pass `memo_id`): the callback patches an existing memo\'s ' +
        '     where_* fields. Use after save_memo when you saved the structural info but ' +
        '     still need GPS.\n\n' +
        'Returns { url, expiresAt, ttlSeconds, what?, memoId? }. Reply to the user with ' +
        'markdown link syntax `[👉 点击共享当前位置](url)` on its own line so iLink renders ' +
        'a tappable label (the URL itself stays hidden). Do NOT print the raw URL.\n\n' +
        'After the user taps and grants permission, agim pushes a "✅ 已记下..." confirmation ' +
        'to this thread directly — you do NOT need to wait. Link is single-use and expires in ' +
        '10 minutes. EXPIRY for the memo itself is set via save_memo separately if needed; ' +
        'capture-flow memos default to permanent unless you call save_memo first with ' +
        'expires_in_hours then attach via memo_id here.',
      inputSchema: {
        what: z.string().optional().describe('Short label for what is being recorded (e.g. "车", "伞"). Used as the new memo\'s what field. ≤80 chars. Mutually exclusive with memo_id.'),
        memo_id: z.number().int().positive().optional().describe('Existing memo id to augment with GPS instead of creating a new one. Mutually exclusive with what.'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('request_capture'),
  )

  server.registerTool(
    'search_memos',
    {
      title: 'Search the user\'s memos',
      description:
        'Recall memos for ANY query the user makes about their saved knowledge: "我的车在哪" / ' +
        '"我爸爸的生日" / "上周记了什么" / "找下AVP2那条". Combines free-text query with optional ' +
        'structured filters; all filters AND-combine. Empty query returns most recent.\n\n' +
        'Examples:\n' +
        '  "我的车在哪？"        → { query: "车", has_location: true }\n' +
        '  "我爸爸生日是哪天？" → { who: "爸爸", what: "生日" }\n' +
        '  "今天记了什么？"     → { when_after: "<2026-05-11 00:00:00>" }  (UTC+8)\n' +
        '  "找下苹果发布会"     → { query: "苹果发布会" }\n\n' +
        'Returns { items: [{ id, what, who, whenAt/whenText, where: { lat, lng, label, mapUrl, ' +
        'mapUrls } if location set, how, why, memo (full user phrasing when set), expiresAt, ' +
        'createdAt }] }. Format the answer naturally for the user: 1-2 sentences summarizing the ' +
        'find + (if where set) all three map URLs using markdown links `[百度地图](url) · ' +
        '[高德地图](url) · [Google](url)`. When `memo` is set on the match (the full original ' +
        'phrasing), quote it briefly so the user recognizes the entry. Do NOT print raw URLs. ' +
        'If multiple matches, lead with the most recent.',
      inputSchema: {
        query: z.string().optional().describe('Free-text — fuzzy LIKE match across what/who/where_label/how/why/when_text/memo'),
        who: z.string().optional().describe('Filter by who field (LIKE match)'),
        what: z.string().optional().describe('Filter by what field (LIKE match)'),
        has_location: z.boolean().optional().describe('When true, only memos with where_lat set'),
        when_after: z.string().optional().describe('Asia/Shanghai (UTC+8) datetime — memos with when_at OR created_at >= this. Format "YYYY-MM-DD HH:MM:SS"'),
        when_before: z.string().optional().describe('Asia/Shanghai (UTC+8) datetime — memos with when_at OR created_at <= this'),
        include_expired: z.boolean().optional().describe('Include expired memos in results (default false)'),
        limit: z.number().int().min(1).max(50).optional().describe('Max rows (default 10)'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('search'),
  )

  server.registerTool(
    'update_memo',
    {
      title: 'Patch fields on an existing memo',
      description:
        'Update ANY 5W1H field on an existing memo. CALL THIS when the user adds info to a ' +
        'previously-saved memo: "对了，那个会议在 3 楼 A 区" → update_memo({ id, where_label: ' +
        '"3楼A区" }). Or to extend / shorten the expiry: "把车那条改成永久" → update_memo({ ' +
        'id, expires_at: null }).\n\n' +
        'Pass null to a field to CLEAR it (vs omitting which leaves alone). For expiry, you ' +
        'can pass either expires_in_hours (relative) or expires_at (absolute ISO; null clears).\n\n' +
        '🌍 ADDRESS PATH: when the user gives you a textual address ("在国贸三期" / "北京天安门"), ' +
        'pass `address` and the server will geocode it via Baidu Maps + populate where_lat/lng/' +
        'label in one shot. Use this for the "place-memo augment" flow — after save_memo of a ' +
        'place without coords, the user replies with an address → call update_memo({id, address}). ' +
        'If `address` is provided AND where_lat/lng are NOT explicitly set, the geocoded coords ' +
        'fill them. If you also pass where_label, it overrides the geocoded one (so user\'s ' +
        '"老孙家" beats Baidu\'s "X街 Y号").\n\n' +
        '📍 GPS PATH: if the user is AT the place right now ("我现在就在那"), do NOT use ' +
        'update_memo — call request_location_capture({memo_id}) instead, which sends a ' +
        'one-time browser-GPS link. The H5 callback patches the existing memo\'s where_*.\n\n' +
        'Returns the updated memo summary. Confirm to the user with one sentence + (if where_* ' +
        'now set) the markdown map links.',
      inputSchema: {
        id: z.number().int().positive().describe('Memo id from search_memos'),
        what: z.string().optional(),
        who: z.string().nullable().optional(),
        when_at: z.string().nullable().optional(),
        when_text: z.string().nullable().optional(),
        where_lat: z.number().min(-90).max(90).nullable().optional(),
        where_lng: z.number().min(-180).max(180).nullable().optional(),
        where_label: z.string().nullable().optional(),
        address: z.string().optional().describe('Free-text address — server geocodes + sets where_lat/lng. Mutually compatible with where_label override.'),
        how: z.string().nullable().optional(),
        why: z.string().nullable().optional(),
        expires_in_hours: z.number().positive().optional(),
        expires_at: z.string().nullable().optional().describe('ISO datetime or null to clear'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('update'),
  )

  server.registerTool(
    'delete_memo',
    {
      title: 'Delete a memo by id',
      description:
        'Remove a memo. Find ids via search_memos. Use when user explicitly says to delete / ' +
        'forget / clear ("删了车那条" / "把生日那条记录忘掉"). ⚠️ Permanent — confirm with the ' +
        'user before calling for important-looking memos (no expiry set, who/when fields populated).',
      inputSchema: {
        id: z.number().int().positive().describe('Memo id from search_memos'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('delete'),
  )

  // ─── v1.3 — agent-initiated push to an IM thread ─────────────────
  // Lets the running agent send a message to its own (or a same-platform/
  // same-user) IM thread without waiting for a user prompt. Use cases:
  // monitoring loops, long-task progress updates, scheduled analyses.
  //
  // Default scope = caller's own thread. Cross-thread requires
  // AGIM_PUSH_CROSS_THREAD=on. Rate limit AGIM_PUSH_RATE_PER_MINUTE
  // (default 10/min/user).
  // ─── P0 #5 — structured ask_user ─────────────────────────────────
  // The agent presents a structured question with 2-9 choices and waits
  // for the user to answer. Supports single-select (default), multi-
  // select, and optional custom free-form input. Use this for explicit
  // clarification ("did you mean A or B?") rather than forcing the user
  // back into free-form chat.
  server.registerTool(
    'ask_user',
    {
      title: 'Ask the user a multi-choice question and wait for the answer',
      description:
        '**USE THIS TOOL when you need a structured choice from the user** — disambiguation, ' +
        'confirm-then-proceed flows, picking one of several known options. The user sees a button ' +
        'card on platforms that support it (Telegram / Feishu / Discord); other platforms (WeChat / ' +
        'DingTalk) receive a numbered text prompt and the user replies with the number or label.\n\n' +
        'Returns { ok: true, result: { index, label, via, raw, selectionMode?, indexes?, labels?, customText? } } on success; ' +
        '{ ok: false, error, reason } on failure (reason ∈ timeout|cancelled|invalid|no-messenger). ' +
        'Timeout defaults to 900s (15 min); the user gets a single chance to respond.\n\n' +
        'Do NOT use for: free-form questions (just ask in chat), Y/N permission gates (those go ' +
        'through the regular tool-use approval flow), or polling (call once + wait, do not loop).',
      inputSchema: {
        question: z.string().min(1).max(1000).describe('The question to show the user. 1-1000 chars.'),
        choices: z.array(z.string().min(1).max(80)).min(2).max(9).describe(
          '2-9 distinct option labels (each ≤80 chars). Shown to the user in order; the result\'s `index` is 1-based.',
        ),
        timeoutSec: z.number().int().min(5).max(1800).optional().describe(
          'Seconds to wait before resolving with reason:timeout. Default 900 (15 min), range 5-1800.',
        ),
        selectionMode: z.enum(['single', 'multi']).optional().describe(
          'Selection mode. `single` (default) expects one option; `multi` allows selecting multiple options at once.',
        ),
        minSelections: z.number().int().min(1).optional().describe(
          'Only for `selectionMode=multi`. Minimum number of selected options. Default 1.',
        ),
        maxSelections: z.number().int().min(1).optional().describe(
          'Only for `selectionMode=multi`. Maximum number of selected options. Default = choices.length.',
        ),
        allowCustomInput: z.boolean().optional().describe(
          'When true, user may answer with custom free-form text instead of choosing listed options.',
        ),
        customInputLabel: z.string().min(1).max(80).optional().describe(
          'Optional display label for the custom-input option in richer clients.',
        ),
        allowTextReply: z.boolean().optional().describe(
          'When true (default), user can type the number / letter / label substring; when false, only button taps resolve.',
        ),
        _im_context: imContextSchema,
      },
    },
    async (args: Record<string, unknown>) => {
      const result = await client.requestAsk(args)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  // ─── Stage 3 / P0 #3 — read_skill ────────────────────────────────
  // The agim skills loader injects tier-1 (name + description) of each
  // skill into every system prompt. When the agent decides a skill
  // matches the user's intent, it calls this tool to fetch the full
  // SKILL.md body (tier 2). Subdirectories (scripts/ references/
  // assets/) are tier-3 and read via the agent's existing file-read
  // tool — the skill body documents the paths.
  server.registerTool(
    'read_skill',
    {
      title: 'Read the full SKILL.md body for an agim skill',
      description:
        '**USE THIS TOOL when the user\'s request matches the description of a skill listed in your '
        + 'system prompt under "[agim skills available …]".** Returns the full SKILL.md body so you can '
        + 'follow its instructions. For a roster of every available skill, use op="list". After dropping '
        + 'a new SKILL.md on disk the operator may ask you to op="refresh".\n\n'
        + 'Returns { ok: true, result: { op:"read", name, body, available, unavailableReason? } } on '
        + 'success; { ok: false, error } on failure. body length capped at ~32k chars; oversize bodies '
        + 'come back with a truncation footer.',
      inputSchema: {
        op: z.enum(['read', 'list', 'refresh']).optional().default('read').describe(
          'Operation: read one body (default), list all skills, or refresh the disk cache.',
        ),
        name: z.string().optional().describe(
          'Required for op="read". Case-insensitive lookup against the skill directory names.',
        ),
      },
    },
    async (args: Record<string, unknown>) => {
      const op = typeof args.op === 'string' ? args.op : 'read'
      const name = typeof args.name === 'string' ? args.name : undefined
      const result = await client.requestSkill(op, name ? { name } : {})
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'push_message',
    {
      title: 'Push a proactive message to the IM thread',
      description:
        '**USE THIS TOOL when you need to send a message to the user without waiting for them to ask first** — ' +
        'monitoring alerts, long task progress, scheduled analysis results. ' +
        'By default the message goes to YOUR OWN current IM thread (the same thread that invoked you). ' +
        'Cross-thread pushes require the operator to enable AGIM_PUSH_CROSS_THREAD=on AND must target the ' +
        'same platform AND same user as the caller — there is no "push to anyone" capability.\n\n' +
        'Rate limit: 10 pushes/min/user by default (AGIM_PUSH_RATE_PER_MINUTE). Above cap → returns error.\n\n' +
        'Returns { ok: true, result: { outboxId, immediate, targetThread } } on success.\n\n' +
        'Triggers (Chinese): 「监控到 X 时通知我」「这个任务跑完时告诉我」「每天 8 点把 X 推给我」 — ' +
        'when you finally HAVE the result, call this tool to push.\n\n' +
        'Do NOT use for: ordinary replies to user messages (those go via your normal output stream).',
      inputSchema: {
        text: z.string().min(1).max(4000).describe('Message body. Plain text or markdown. Required.'),
        toThread: z.string().optional().describe(
          'Optional override: "platform:channelId:threadId". Same-platform same-user only; requires AGIM_PUSH_CROSS_THREAD=on. Omit for caller\'s own thread.',
        ),
        _im_context: imContextSchema,
      },
    },
    async (args: Record<string, unknown>) => {
      const result = await client.requestPush(args)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  // ─── v1.5 — long-term memory ──────────────────────────────────────
  // FTS5-backed fact store + persona profile. Use memory_query when the
  // user references something they've previously told you (preferences,
  // holdings, projects, names, places). Use memory_save when you learn
  // something worth remembering long-term.
  const wrapMemory = (op: string) => async (args: Record<string, unknown>) => {
    const result = await client.requestMemory(op, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  }

  server.registerTool(
    'memory_query',
    {
      title: 'Recall facts about the current user',
      description:
        '**USE THIS TOOL when the user references something they\'ve told you before** — preferences, '
        + 'holdings, projects, family / friend names, places, recurring tasks. The persona summary in '
        + 'your system prompt covers the top-level "who is this person"; memory_query digs into '
        + 'specific facts. Hybrid retrieval: FTS5 keyword + recency. Returns { matched, facts[] } where '
        + 'each fact has { id, what, who, when_text, where_label, why, category, confidence }. Use '
        + 'confidence to weigh how much to trust each fact. Empty query → most-recent N facts.\n\n'
        + 'Triggers (Chinese): 「我之前说过 X」「我的 Y 是什么来着」「上次提到的 Z」 — query then answer.',
      inputSchema: {
        query: z.string().optional().describe('Free-text query. Leave empty for most-recent N facts.'),
        category: z.enum(['fact', 'preference', 'goal', 'history', 'profile']).optional(),
        k: z.number().int().min(1).max(50).optional().describe('Max facts to return (default 5)'),
        _im_context: imContextSchema,
      },
    },
    wrapMemory('query'),
  )

  server.registerTool(
    'memory_save',
    {
      title: 'Remember a fact about the current user long-term',
      description:
        '**Call this when you LEARN something worth remembering** that the post-reply auto-distillation '
        + 'might miss. Examples: user explicitly says "记住 X" / "我喜欢 Y", or you infer a strong '
        + 'preference / commitment that should persist across sessions. Returns { id } on success. '
        + 'Set confidence > 0.8 when the user said it directly, ~0.6 when inferred. Use sparingly — '
        + 'auto-distillation already runs after every reply.',
      inputSchema: {
        what: z.string().min(1).max(500).describe('1-sentence fact. Required.'),
        who: z.string().optional().describe('Subject (user / 用户 / friend name)'),
        when_text: z.string().optional().describe('Time reference if relevant'),
        where_label: z.string().optional().describe('Place if relevant'),
        why: z.string().optional().describe('Context / motivation if relevant'),
        category: z.enum(['fact', 'preference', 'goal', 'history', 'profile']).optional(),
        confidence: z.number().min(0).max(1).optional().describe('0-1; default 0.6'),
        _im_context: imContextSchema,
      },
    },
    wrapMemory('save'),
  )

  server.registerTool(
    'memory_list',
    {
      title: 'List recent facts for inspection',
      description:
        'Lists the user\'s most recent N facts (no query filter). Mainly for debugging / when the '
        + 'user asks "你记得我什么". Prefer memory_query for normal recall flows.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
        _im_context: imContextSchema,
      },
    },
    wrapMemory('list'),
  )

  server.registerTool(
    'memory_delete',
    {
      title: 'Delete a fact by id',
      description:
        'Removes a fact by id (from memory_list or memory_query). CALL THIS when the user says '
        + '"忘掉这个" / "这条不对" — they\'re correcting a wrong / stale fact. Returns { deleted: '
        + 'bool }.',
      inputSchema: {
        id: z.number().int().positive().describe('Fact id from memory_query / memory_list'),
        _im_context: imContextSchema,
      },
    },
    wrapMemory('delete'),
  )

  // ─── A2A — agent-to-agent call (CLI Subagent dispatch) ────────────
  // Lets the running sticky CLI program-call another registered agent and wait
  // for the result inside its own tool loop. Bus enforces depth + self-call
  // rejection + workspace whitelist; the callee runs in a fresh inline-job row.
  //
  // Product split: CLI parents MAY spawn Subagents (call_agent / call_agents).
  // Loop Engineering (`/loop`, loop_verdict, Focus tools) stays Agim-only —
  // switch sticky to Agim for L3 orchestration.
  const a2aInputFields = {
    timeoutMs: z.number().int().positive().optional().describe(
      'Optional override for the wait timeout. Defaults to AGIM_A2A_TIMEOUT_DEFAULT_MS. '
      + 'The callee keeps running on timeout, but you stop waiting and get an error.',
    ),
    inputs: z.array(
      z.object({
        name: z.string().describe('Filename inside the callee _agim-input/ dir (no slashes, no "..").'),
        fromAbsolutePath: z.string().optional().describe(
          'Absolute path on the host to copy from. Hard-linked when same fs, else copied. '
          + 'Exactly one of fromAbsolutePath / fromCallerOutput / content must be set.',
        ),
        fromCallerOutput: z.string().optional().describe(
          'Filename in YOUR own _agim-output/ — useful for chaining A→B→C, where B forwards '
          + 'something it just produced as input to C. Resolved relative to caller jobId.',
        ),
        content: z.string().optional().describe(
          'Inline UTF-8 text content. Use for short text inputs; large blobs prefer fromAbsolutePath.',
        ),
      }),
    ).optional().describe(
      'Files to provision in the callee\'s _agim-input/ before it runs. Each input must '
      + 'specify exactly one source.',
    ),
    expectOutputs: z.array(z.string()).optional().describe(
      'Filenames you expect the callee to leave in its _agim-output/. Soft contract — '
      + 'missing files become entries in `warnings`, not a hard error.',
    ),
  }

  server.registerTool(
    'call_agent',
    {
      title: 'Call another agent',
      description:
        'Spawn ONE Subagent (nested worker) and wait for its reply. You keep the user-facing reply. '
        + '**USE THIS whenever the user names a different agent** (codex / claude-code / agim / …) '
        + 'or when a well-scoped sub-task fits another backend. '
        + 'Do NOT respond "I can\'t call X". '
        + 'For 2+ independent lanes use `call_agents` instead. '
        + 'Brief must be self-contained (callee does NOT see your history). '
        + 'Agim enforces depth limit + self-call ban + workspace ACL. '
        + '**Not for Loop Engineering** — `/loop` / `loop_verdict` are Agim-only; switch to Agim for L3. '
        + 'Returns {ok, result, jobId, agent, durationMs, …} or {ok:false, error}.',
      inputSchema: {
        agent: z.string().describe(
          'Target agent name or alias, for example agim, claude-code, codex, copilot, opencode, '
          + 'kimi-code, qoder, pi, mimo. Must not be the calling agent itself (unless isolate path).',
        ),
        prompt: z.string().describe(
          'Self-contained brief: Objective + Output format + Boundaries + Done-when. '
          + 'Require key findings in the child FINAL message; cite absolute paths if writing files.',
        ),
        ...a2aInputFields,
      },
    },
    async (args) => {
      const result = await client.requestCallAgent({
        agent: typeof args.agent === 'string' ? args.agent : '',
        prompt: typeof args.prompt === 'string' ? args.prompt : '',
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        ...(Array.isArray(args.inputs) ? { inputs: args.inputs as Parameters<typeof client.requestCallAgent>[0]['inputs'] } : {}),
        ...(Array.isArray(args.expectOutputs) ? { expectOutputs: args.expectOutputs as string[] } : {}),
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    'call_agents',
    {
      title: 'Call multiple agents',
      description:
        'Spawn MULTIPLE Subagents in one call (fan-out / join). You keep the user-facing reply. '
        + 'Use when 2–3 lanes are independent (research / verify / explore). '
        + 'Each tasks[] item needs a self-contained brief. '
        + 'Do not parallel-write the same file — split directories or serialize. '
        + 'Failure mode: allSettled — one child fail does not kill siblings; synthesize all results. '
        + `Hard max ${CALL_AGENTS_TASKS_HARD_MAX} tasks; concurrency via AGIM_SUBAGENT_PARALLEL*. `
        + '**Not for Loop Engineering** — `/loop` / `loop_verdict` stay on Agim Agent. '
        + 'Returns {ok:true, okCount, parallel, concurrency, lanes:[…]} or {ok:false, error}.',
      inputSchema: {
        tasks: z.array(
          z.object({
            agent: z.string().describe(
              'Registry agent id or alias (agim / claude-code / codex / …).',
            ),
            prompt: z.string().describe(
              'Self-contained brief: Objective + Output format + Boundaries + Done-when.',
            ),
            ...a2aInputFields,
          }),
        ).min(1).max(CALL_AGENTS_TASKS_HARD_MAX).describe(
          `Independent Subagent tasks (1–${CALL_AGENTS_TASKS_HARD_MAX}). Prefer 2–3 lanes.`,
        ),
      },
    },
    async (args) => {
      const raw = Array.isArray(args.tasks) ? args.tasks : []
      const tasks = raw.map((t) => ({
        agent: typeof t?.agent === 'string' ? t.agent : '',
        prompt: typeof t?.prompt === 'string' ? t.prompt : '',
        ...(typeof t?.timeoutMs === 'number' ? { timeoutMs: t.timeoutMs } : {}),
        ...(Array.isArray(t?.inputs)
          ? { inputs: t.inputs as Parameters<typeof client.requestCallAgent>[0]['inputs'] }
          : {}),
        ...(Array.isArray(t?.expectOutputs) ? { expectOutputs: t.expectOutputs as string[] } : {}),
      }))
      const result = await client.requestCallAgents(tasks)
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      }
      const text = [
        `[call_agents join] ${result.okCount}/${result.lanes.length} succeeded `
        + `(parallel=${result.parallel ? 'on' : 'off'}, concurrency=${result.concurrency}).`,
        'Synthesize the lane results below into one user reply; do not dump raw transcripts.',
        JSON.stringify({
          ok: true,
          okCount: result.okCount,
          parallel: result.parallel,
          concurrency: result.concurrency,
          lanes: result.lanes,
        }),
      ].join('\n')
      return { content: [{ type: 'text' as const, text }] }
    },
  )

  return server
}

export { ApprovalClient }

async function main(): Promise<void> {
  const sockPath = process.env.AGIM_APPROVAL_SOCK
  if (!sockPath) {
    process.stderr.write('[mcp-approval-server] missing AGIM_APPROVAL_SOCK\n')
    process.exit(1)
  }
  // AGIM_RUN_ID is optional. Per-spawn paths (claude-code --mcp-config,
  // opencode stdio extraEnv) set a unique runId so the bus can look up
  // the IM thread context. Long-lived shared paths (opencode http daemon
  // spawning the MCP server once at startup) leave it unset; reminder.*
  // tool calls then route via the agent-asserted `_im_context` payload.
  // Approval tool calls without a runId can't be routed and will be
  // denied by the bus — but those paths don't use this sidecar anyway
  // (opencode http does approvals via SSE, not MCP).
  const runId = process.env.AGIM_RUN_ID || ''

  const client = new ApprovalClient(sockPath, runId)
  const server = buildServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // When stdio closes (claude went away), shut down cleanly.
  const shutdown = async (): Promise<void> => {
    try { await client.close() } catch { /* ignore */ }
    try { await server.close() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Detect "run as script" — when imported by tests we don't want to spin up stdio.
const isMainModule = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    const url = new URL(import.meta.url)
    return url.pathname.endsWith(process.argv[1].replace(/^.*?(?=\/|$)/, '')) ||
      url.pathname === process.argv[1] ||
      process.argv[1].endsWith('mcp-approval-server.js')
  } catch { return false }
})()

if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`[mcp-approval-server] fatal: ${err}\n`)
    process.exit(1)
  })
}
