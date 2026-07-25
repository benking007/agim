// approval-bus — IM 端人工审批的进程内总线
//
// 角色：在 agim 主进程里跑一个 unix socket 服务，等 claude 子进程的
// MCP "approval sidecar" 通过 socket 连进来发审批请求。bus 自己不决策，
// 只做三件事：
//   1. 把请求转给 notifier（由 messenger 层注入：负责推 IM 卡片）
//   2. 维护 pending 队列，按 threadId 索引，等 resolvePending 回流决策
//   3. 超时 / 进程退出 / 连接断开 时自动 deny，保证 sidecar 端不会卡死
//
// 协议：unix socket + NDJSON，每行一个 JSON 对象。
//   sidecar → bus:  {v:1, type:"approval", runId, reqId, toolName, input, toolUseId}
//   bus → sidecar:  {v:1, type:"decision", reqId, behavior:"allow"|"deny", ...}
//
// 单实例 export approvalBus；测试可 new ApprovalBus({approvalTimeoutMs}) 调小超时。

import { createServer, type Server, type Socket } from 'node:net'
import { unlink, stat as fsStat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger as rootLogger } from './logger.js'
import { eventBus } from './event-bus.js'
import { dispatchRpc } from './approval/socket-rpc.js'
import type { ApprovalRpcHost } from './approval/socket-rpc.js'
import {
  type PendingApproval,
  removePending,
  addAutoAllowRule,
  removeAutoAllowRule,
  evictOldestPending,
} from './approval/pending.js'
import {
  isAutoApproveEnabled,
  isAutoApproveEffective,
  isTimeoutDefaultAllow,
  announceTimeoutDefaultIfAllow,
  stopTimeoutDefaultReminder,
  READONLY_TOOLS,
  READONLY_AUTO_ALLOW_GLOBAL_ENABLED,
} from './approval/policy.js'
import {
  autoAllowRuleKey,
  humanizeFingerprint,
  inputFingerprint,
} from './approval/fingerprint.js'
import type {
  RunContext,
  Decision,
  ApprovalNotification,
  ApprovalNotifier,
  ResolvedInfo,
  ResolutionCause,
  ResolutionEvent,
  ResolutionListener,
  ApprovalBusOptions,
} from './approval/types.js'
import { threadKey } from './approval/types.js'

export type {
  RunContext,
  Decision,
  ApprovalNotification,
  ApprovalNotifier,
  ResolvedInfo,
  ResolutionCause,
  ResolutionEvent,
  ResolutionListener,
  ApprovalBusOptions,
}
export { threadKey }
export {
  isAutoApproveEnabled,
  isAutoApproveEffective,
  isTimeoutDefaultAllow,
  announceTimeoutDefaultIfAllow,
  stopTimeoutDefaultReminder,
}
export { humanizeFingerprint, inputFingerprint }

const log = rootLogger.child({ component: 'approval-bus' })

// Default 30 min — human review of tool args (esp. unconfined exec /
// plan-exit) often needs more than a short glance, and the card must
// outlive slow IM round-trips. When AGIM_AUTO_APPROVE is on, this
// timeout is irrelevant (tools are approved immediately without
// waiting). This value only matters when a human is expected to respond.
const DEFAULT_APPROVAL_TIMEOUT_MS = parseEnvMs(
  process.env.AGIM_APPROVAL_TIMEOUT_MS,
  30 * 60 * 1000,
)
const DEFAULT_AUTO_ALLOW_GRACE_MS = 5 * 1000

// v1.3.7 (F8) — hard cap on concurrently-pending approvals. Without it,
// pendingById / pendingByThread grow unbounded: a misbehaving agent (or a
// flood of tool calls) can pin tens of thousands of timers + objects in
// memory. When the cap is hit we evict the OLDEST unresolved request with a
// deny so the maps stay bounded. Generous default; override via env.
const MAX_PENDING_APPROVALS = (() => {
  const n = Number(process.env.AGIM_APPROVAL_MAX_PENDING)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000
})()

function parseEnvMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}
const MAX_LINE_BYTES = 256 * 1024
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 4


export class ApprovalBus {
  private server: Server | null = null
  private socketPath: string | null = null
  /** Public so renderers (approval-router plain-text prompt, future card
   *  variants) can show the actual budget instead of hardcoded "5 分钟". */
  public readonly approvalTimeoutMs: number
  public readonly autoAllowGraceMs: number

  private runContexts = new Map<string, RunContext>()
  private pendingById = new Map<string, PendingApproval>()
  private pendingByThread = new Map<string, PendingApproval[]>()
  private connections = new Set<Socket>()
  private notifier: ApprovalNotifier | null = null
  private resolutionListener: ResolutionListener | null = null
  /** compositeKey → set of `${toolName}::${prefix}` keys the user has marked
   *  as auto-allow within this conversation. Cleared by clearAutoAllowForThread
   *  (called from session.resetConversation) and on stop(). Key format is
   *  `platform:channelId:threadId` to isolate across platforms/channels. */
  private autoAllowByThread = new Map<string, Set<string>>()

  /** Per-thread opt-out for readonly auto-allow. Default: enabled (= empty
   *  set means everyone is opted in). Toggled via /approval readonly on|off.
   *  In-memory only — survives no restarts; restart returns to default-on,
   *  matching the env-var default. */
  private readonlyAutoAllowDisabledThreads = new Set<string>()

  /**
   * Lifetime counters surfaced via {@link getMetrics}. Help ops detect
   * leaks (pending growing unbounded), spikes (totalRequests rate), and
   * approval skew (deny:allow ratio). Reset on stop() so the gauge for a
   * fresh process starts at zero.
   */
  private metricsSnapshot = {
    totalRequests: 0,
    totalResolved: 0,
    totalAllowed: 0,
    totalDenied: 0,
    totalTimedOut: 0,
    totalReadonlyAutoAllowed: 0,
  }

  /** Adapter exposing the minimal ApprovalRpcHost surface to socket-rpc handlers. */
  private readonly rpcHost: ApprovalRpcHost = {
    getRunContext: (runId) => this.runContexts.get(runId),
    registerSyntheticPending: (input) => this.registerSyntheticPending(input),
  }

  constructor(opts: ApprovalBusOptions = {}) {
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.autoAllowGraceMs = opts.autoAllowGraceMs ?? DEFAULT_AUTO_ALLOW_GRACE_MS
  }

  /** 注入"通知 IM 推送"的回调。messenger 层启动时调一次。 */
  setNotifier(n: ApprovalNotifier | null): void {
    this.notifier = n
  }

  /** Subscribe to resolution events. Replaces any previous listener.
   *  approval-router uses this to keep its UI cards in sync with bus-side
   *  cancellations (timeout / sidecar disconnect / run terminated). The
   *  user-driven path (button or y/n text) already edits its own card; the
   *  listener still fires there with cause='user' so consumers can dedup. */
  setResolutionListener(l: ResolutionListener | null): void {
    this.resolutionListener = l
  }

  /** 启动 unix socket 服务。返回最终使用的 socket 路径。 */
  async start(socketPath?: string): Promise<string> {
    if (this.server) throw new Error('approval-bus already started')
    const path = socketPath ?? defaultSocketPath()
    try { await unlink(path) } catch { /* stale socket cleanup */ }

    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket))
      const onErr = (err: Error): void => { reject(err) }
      server.once('error', onErr)
      server.listen(path, () => {
        server.removeListener('error', onErr)
        this.server = server
        this.socketPath = path
        // Harden file permissions: net.Server.listen creates the socket file
        // with the current umask (typically 0022 → 0644 / 0666). chmod 0o600
        // ensures only the current user can connect, and the post-chmod stat
        // surfaces a warning if (somehow) it's still loose — useful in shared
        // hosts where umask was relaxed at some startup script.
        void (async (): Promise<void> => {
          try {
            await chmod(path, 0o600)
            const st = await fsStat(path)
            if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
              log.warn({
                event: 'approval.bus.socket_perms_loose',
                mode: (st.mode & 0o777).toString(8),
                path,
              }, 'Approval socket file is group/world accessible — set umask=0077 to harden')
            }
          } catch { /* non-fatal */ }
        })()
        log.info({ event: 'approval.bus.started', path })
        resolve(path)
      })
    })
  }

  async stop(): Promise<void> {
    // Reject everything still pending
    for (const p of [...this.pendingById.values()]) {
      this.cancelPending(p, { behavior: 'deny', message: 'approval-bus shutting down' }, 'shutdown')
    }
    this.runContexts.clear()
    this.pendingById.clear()
    this.pendingByThread.clear()
    this.autoAllowByThread.clear()
    this.readonlyAutoAllowDisabledThreads.clear()
    // Reset lifetime counters so a restarted process starts at 0 — keeps
    // `rate(im_hub_approval_requests_total)` correct without ops needing
    // to track process restarts in the alert query.
    this.metricsSnapshot = { totalRequests: 0, totalResolved: 0, totalAllowed: 0, totalDenied: 0, totalTimedOut: 0, totalReadonlyAutoAllowed: 0 }

    // server.close() doesn't terminate existing connections. Half-close each
    // (so the deny payload buffered above gets flushed) and fall back to
    // destroy() after a short grace window if the peer doesn't disconnect.
    const conns = [...this.connections]
    this.connections.clear()
    await Promise.all(conns.map((s) => new Promise<void>((resolve) => {
      if (s.destroyed) { resolve(); return }
      s.once('close', () => resolve())
      try { s.end() } catch { /* ignore */ }
      setTimeout(() => { if (!s.destroyed) s.destroy() }, 200).unref()
    })))

    const srv = this.server
    if (!srv) return
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    this.server = null
    if (this.socketPath) {
      try { await unlink(this.socketPath) } catch { /* ignore */ }
      this.socketPath = null
    }
  }

  registerRun(runId: string, ctx: RunContext): void {
    this.runContexts.set(runId, ctx)
  }

  /** 进程结束时调。pending 全 deny，runContext 清掉。 */
  unregisterRun(runId: string): void {
    this.runContexts.delete(runId)
    for (const p of [...this.pendingById.values()]) {
      if (p.runId === runId) {
        this.cancelPending(p, { behavior: 'deny', message: 'run terminated' }, 'run-terminated')
      }
    }
  }

  /** Check if there are pending approvals for the given composite key.
   *  `key` must be a composite produced by `threadKey(platform, channelId,
   *  threadId)` — that's what register stores under. A bare threadId will
   *  miss in multi-platform deployments. */
  hasPendingFor(key: string): boolean {
    return (this.pendingByThread.get(key)?.length ?? 0) > 0
  }

  /** True iff a notifier has been installed (i.e. messenger layer has wired
   *  the bus into IM). Callers that have a fallback path (e.g. the opencode
   *  HTTP adapter) check this before registerSyntheticPending so they can
   *  short-circuit when the bus is dormant — mostly relevant in tests and in
   *  non-IM call paths (web, scheduler). */
  hasNotifier(): boolean {
    return this.notifier !== null
  }

  /**
   * 由 messenger.onMessage 拦截层调用。把 thread 队列头部的 pending 用
   * 给定决策 resolve 掉。返回被 resolve 的 pending 描述（platform / tool /
   * fingerprint / 是否处于 auto-allow grace 模式）；router 用这些信息发回执。
   * 没有 pending 时返回 null。
   *
   * Auto-allow side-effect: a user-initiated deny against a pending that
   * was running in auto-allow mode revokes the matching rule (the user is
   * signaling "stop auto-approving this"). Revocation is intentionally
   * scoped to this user-path so sidecar disconnects / shutdown / run-
   * terminated denies don't accidentally clear rules the user still wants.
   */
  /** Resolve the FIFO head for the given composite key. `key` must be a
   *  composite produced by `threadKey(platform, channelId, threadId)`. The
   *  text-reply path (cli's tryHandleApprovalReply) is the canonical caller;
   *  button callbacks should use `resolvePendingByReqId` instead. */
  resolvePending(key: string, decision: Decision, actorUserId?: string): ResolvedInfo | null {
    const q = this.pendingByThread.get(key)
    const head = q?.[0]
    if (!head) return null
    return this._resolveTarget(head, decision, actorUserId)
  }

  /**
   * Resolve a specific pending approval identified by reqId. Used by button
   * callbacks and the dashboard where the UI element carries the exact reqId,
   * avoiding the FIFO head-of-thread ambiguity of resolvePending().
   */
  resolvePendingByReqId(reqId: string, decision: Decision, actorUserId?: string): ResolvedInfo | null {
    const target = this.pendingById.get(reqId)
    if (!target || target.resolved) return null
    return this._resolveTarget(target, decision, actorUserId)
  }

  /** Cancel a specific request from a non-user lifecycle event. Unlike
   * resolvePendingByReqId this preserves the cause so card renderers expire
   * stale buttons instead of treating an abort as a human click. */
  cancelPendingByReqId(
    reqId: string,
    message: string,
    cause: Exclude<ResolutionCause, 'user'> = 'run-terminated',
  ): boolean {
    const target = this.pendingById.get(reqId)
    if (!target || target.resolved) return false
    this.cancelPending(target, { behavior: 'deny', message }, cause)
    return true
  }

  private _resolveTarget(
    target: PendingApproval,
    decision: Decision,
    actorUserId?: string,
  ): ResolvedInfo | null {
    if (
      target.requiresExplicitDecision
      && (!actorUserId || actorUserId !== target.approverUserId)
    ) {
      log.warn({
        event: 'approval.bus.explicit_actor_mismatch',
        reqId: target.reqId,
        expectedUserId: target.approverUserId,
        actorUserId: actorUserId ?? '',
      })
      return null
    }
    if (
      target.requiresExplicitDecision
      && !target.allowSessionPin
      && decision.behavior === 'allow'
      && decision.autoAllowFurther
    ) {
      // Mutate the caller-visible decision too: approval-router uses the same
      // object for receipts/card outcomes after resolvePending returns.
      delete decision.autoAllowFurther
    }
    const platform = this.runContexts.get(target.runId)?.platform ?? ''
    const info: ResolvedInfo = {
      reqId: target.reqId,
      runId: target.runId,
      threadId: target.threadId,
      platform,
      toolName: target.toolName,
      fingerprint: target.fingerprint,
      wasAutoAllow: target.autoAllow,
    }
    if (decision.behavior === 'deny' && target.autoAllow) {
      removeAutoAllowRule(this.autoAllowByThread, target.compositeKey, target.toolName, target.fingerprint)
    }
    this.cancelPending(target, decision, 'user')
    return info
  }

  /** Drop every auto-allow rule registered for this thread. Called from
   *  session.resetConversation so `/new` truly returns to "ask every time".
   *  `key` must be a composite from `threadKey(platform, channelId, threadId)`. */
  clearAutoAllowForThread(key: string): void {
    this.autoAllowByThread.delete(key)
  }

  /** Test/diagnostic helper — current rule keys for a thread. */
  getAutoAllowKeys(key: string): string[] {
    return [...(this.autoAllowByThread.get(key) ?? [])]
  }

  /** Whether readonly auto-allow is active for this thread. False if either
   *  the global env flag is off OR the user explicitly opted this thread out. */
  isReadonlyAutoAllowEnabled(key: string): boolean {
    if (!READONLY_AUTO_ALLOW_GLOBAL_ENABLED) return false
    return !this.readonlyAutoAllowDisabledThreads.has(key)
  }

  /** Per-thread toggle. Returns the new effective state (after applying the
   *  global env constraint — if the env disabled it, returning true is
   *  impossible). */
  setReadonlyAutoAllowEnabled(key: string, enabled: boolean): boolean {
    if (enabled) this.readonlyAutoAllowDisabledThreads.delete(key)
    else this.readonlyAutoAllowDisabledThreads.add(key)
    return this.isReadonlyAutoAllowEnabled(key)
  }

  /** True iff the tool name is in the readonly allowlist. Surface for tests
   *  and the /approval command's status output. */
  isReadonlyTool(toolName: string): boolean {
    return READONLY_TOOLS.has(toolName)
  }

  /** Snapshot of the readonly allowlist. Returns a copy so callers can't
   *  mutate the bus's internal set. */
  getReadonlyTools(): string[] {
    return [...READONLY_TOOLS]
  }

  /** 测试用：当前 socket 路径。 */
  getSocketPath(): string | null { return this.socketPath }

  /**
   * Operational metrics snapshot used by /api/metrics (M14). `pending` is
   * a live count; the totals are lifetime counters that monotonically
   * increase until stop(). The three result buckets (allowed / denied /
   * timedOut) are mutually exclusive and sum to totalResolved — see
   * cancelPending for the bucketing rule. Cheap to call — no allocations
   * beyond the returned object.
   */
  getMetrics(): {
    pending: number
    totalRequests: number
    totalResolved: number
    totalAllowed: number
    totalDenied: number
    totalTimedOut: number
    totalReadonlyAutoAllowed: number
  } {
    return {
      pending: this.pendingById.size,
      totalRequests: this.metricsSnapshot.totalRequests,
      totalResolved: this.metricsSnapshot.totalResolved,
      totalAllowed: this.metricsSnapshot.totalAllowed,
      totalDenied: this.metricsSnapshot.totalDenied,
      totalTimedOut: this.metricsSnapshot.totalTimedOut,
      totalReadonlyAutoAllowed: this.metricsSnapshot.totalReadonlyAutoAllowed,
    }
  }

  /**
   * Snapshot of every currently-pending approval, sanitized for surface
   * to the operator dashboard. Used by the web `/api/approvals` endpoint
   * (and any future ops tooling). Returns a stable JSON shape — input
   * is included verbatim so the UI can render the same preview the
   * IM-side card would; sockets / dispatch closures / timer handles are
   * intentionally omitted.
   *
   * Sorted oldest-first so the queue head is at index 0 (matches the
   * head-of-thread queue semantics used by resolvePending).
   */
  listPending(): Array<{
    reqId: string
    runId: string
    threadId: string
    platform: string
    toolName: string
    input: Record<string, unknown>
    fingerprint: string
    autoAllow: boolean
    registeredAt: number
    ageMs: number
  }> {
    const now = Date.now()
    const out: ReturnType<ApprovalBus['listPending']> = []
    for (const p of this.pendingById.values()) {
      if (p.resolved) continue
      out.push({
        reqId: p.reqId,
        runId: p.runId,
        threadId: p.threadId,
        platform: p.platform,
        toolName: p.toolName,
        input: p.input,
        fingerprint: p.fingerprint,
        autoAllow: p.autoAllow,
        registeredAt: p.registeredAt,
        ageMs: now - p.registeredAt,
      })
    }
    out.sort((a, b) => a.registeredAt - b.registeredAt)
    return out
  }

  // --- internals ---

  private handleConnection(socket: Socket): void {
    this.connections.add(socket)
    let buf = ''
    socket.setEncoding('utf8')

    socket.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_BUFFER_BYTES) {
        log.warn({ event: 'approval.bus.buffer_overflow', bytes: buf.length })
        // L10: best-effort signal to the sidecar BEFORE we close. The
        // legacy `socket.destroy()` left the sidecar's pending request
        // hanging on its own timeout (Claude's MCP layer typically
        // 30 min). A wire-shaped 'fatal' line gives the sidecar a
        // recognizable reason; if it doesn't parse the new type it still
        // observes the socket close and bails through its disconnect
        // handler — strictly better than the silent destroy.
        try {
          socket.write(`${JSON.stringify({ v: 1, type: 'fatal', reason: 'buffer overflow' })}\n`)
          socket.end()
        } catch {
          socket.destroy()
        }
        return
      }
      while (true) {
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.length === 0) continue
        if (line.length > MAX_LINE_BYTES) {
          log.warn({ event: 'approval.bus.line_too_long', len: line.length })
          continue
        }
        this.handleLine(line, socket).catch((err) => {
          log.error({ event: 'approval.bus.handle_error', err: String(err) })
        })
      }
    })

    socket.on('error', (err) => {
      log.warn({ event: 'approval.bus.socket_error', err: String(err) })
    })

    socket.on('close', () => {
      this.connections.delete(socket)
      // sidecar 掉线：相关 pending 全 deny（claude 那边大概率也已经死了，写不写都无所谓）
      for (const p of [...this.pendingById.values()]) {
        if (p.socket === socket) {
          this.cancelPending(p, { behavior: 'deny', message: 'sidecar disconnected' }, 'sidecar-disconnect')
        }
      }
    })
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      log.warn({ event: 'approval.bus.bad_json', line: line.slice(0, 200) })
      return
    }
    if (!msg || typeof msg !== 'object') {
      log.warn({ event: 'approval.bus.bad_msg' })
      return
    }
    const m = msg as Record<string, unknown>
    if (m.v !== 1) {
      log.warn({ event: 'approval.bus.unsupported_version', v: m.v })
      return
    }
    if (m.type === 'approval') {
      await this.handleApproval(m, socket)
      return
    }
    const handled = await dispatchRpc(m, socket, this.rpcHost)
    if (!handled) {
      log.warn({ event: 'approval.bus.unknown_type', type: m.type })
    }
  }

  private async handleApproval(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const runId = typeof m.runId === 'string' ? m.runId : null
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const toolName = typeof m.toolName === 'string' ? m.toolName : null
    const toolUseId = typeof m.toolUseId === 'string' ? m.toolUseId : ''
    const input = (m.input && typeof m.input === 'object' && !Array.isArray(m.input))
      ? m.input as Record<string, unknown>
      : {}

    if (!reqId) {
      log.warn({ event: 'approval.bus.missing_reqId' })
      return  // 没 reqId 没法回包，丢弃
    }
    if (!runId || !toolName) {
      this.sendDecision(socket, reqId, { behavior: 'deny', message: 'invalid approval message' })
      return
    }
    const ctx = this.runContexts.get(runId)
    if (!ctx) {
      this.sendDecision(socket, reqId, { behavior: 'deny', message: `unknown runId: ${runId}` })
      return
    }
    if (this.pendingById.has(reqId)) {
      // 重复 reqId（sidecar bug）：拒绝新的，老的留着
      this.sendDecision(socket, reqId, { behavior: 'deny', message: 'duplicate reqId' })
      return
    }
    if (!this.notifier) {
      this.sendDecision(socket, reqId, { behavior: 'deny', message: 'no notifier installed' })
      return
    }

    await this._registerPending({
      runId, reqId, toolName, toolUseId, input, ctx,
      transport: { socket },
    })
  }

  /**
   * Register an approval request that did NOT come from the unix-socket
   * sidecar. Used by the opencode HTTP bridge (P2): SSE event from opencode
   * → bridge calls this with a `dispatch` callback that POSTs the decision
   * back to opencode's REST API.
   *
   * Behavior is identical to the socket path — same notifier, same timeout,
   * same auto-allow rules — just the delivery channel differs. The
   * `dispatch` is invoked with the final Decision exactly once, on:
   *   - user reply via {@link resolvePending}
   *   - timeout (deny in normal mode, allow in auto-allow mode)
   *   - {@link unregisterRun} (deny: "run terminated")
   *   - {@link stop} (deny: "approval-bus shutting down")
   *
   * dispatch errors are logged and swallowed — the bus must not crash on
   * a misbehaving callback.
   *
   * Idempotent on duplicate reqId: returns silently without firing notify
   * (matches the socket path's "duplicate reqId" handling, minus the wire
   * deny since the synthetic caller has no socket to deny on).
   *
   * Throws synchronously only when the caller's bus state is invalid (no
   * notifier installed). The caller should avoid registering the synthetic
   * pending in that case and fall back to its own deny path.
   */
  async registerSyntheticPending(input: {
    runId: string
    reqId: string
    toolName: string
    input: Record<string, unknown>
    /** Optional — used by Claude's MCP path; defaults to '' for synthetic. */
    toolUseId?: string
    /** Require a one-time human decision; bypasses every automatic allow path. */
    requiresExplicitDecision?: boolean
    /** Allow "Auto for similar" even when `requiresExplicitDecision` is set. */
    allowSessionPin?: boolean
    /** Override the pending timer (e.g. goal confirmation uses its own budget). */
    timeoutMs?: number
    ctx: RunContext
    dispatch: (decision: Decision) => void
  }): Promise<void> {
    if (!this.notifier) {
      // Caller is responsible for handling this case — they have the only
      // backchannel to whatever spawned the request (opencode HTTP, etc.).
      throw new Error('no notifier installed')
    }
    if (this.pendingById.has(input.reqId)) {
      log.warn({ event: 'approval.bus.duplicate_reqId', reqId: input.reqId, source: 'synthetic' })
      return
    }
    // Register run context lazily so callers don't have to pre-call
    // registerRun for every prompt — synthetic pendings already carry full
    // ctx in their argument.
    if (!this.runContexts.has(input.runId)) {
      this.runContexts.set(input.runId, input.ctx)
    }
    await this._registerPending({
      runId: input.runId,
      reqId: input.reqId,
      toolName: input.toolName,
      toolUseId: input.toolUseId ?? '',
      input: input.input,
      ctx: input.ctx,
      requiresExplicitDecision: input.requiresExplicitDecision,
      allowSessionPin: input.allowSessionPin,
      timeoutMs: input.timeoutMs,
      transport: { dispatch: input.dispatch },
    })
  }

  /**
   * Shared register-and-notify pipeline used by both the socket path and the
   * synthetic path. Builds the PendingApproval, wires the timer, fires the
   * notifier, and ensures the timer is cleared if the notifier itself throws.
   */
  private async _registerPending(args: {
    runId: string
    reqId: string
    toolName: string
    toolUseId: string
    input: Record<string, unknown>
    ctx: RunContext
    requiresExplicitDecision?: boolean
    allowSessionPin?: boolean
    /** Optional override for the pending resolution timer. */
    timeoutMs?: number
    transport: { socket: Socket } | { dispatch: (decision: Decision) => void }
  }): Promise<void> {
    const fingerprint = inputFingerprint(args.toolName, args.input)
    const cKey = threadKey(args.ctx.platform, args.ctx.channelId, args.ctx.threadId)
    const allowSessionPin = args.requiresExplicitDecision === true && args.allowSessionPin === true

    // R13 B1 — hard-denylist for sensitive paths / commands. Must come
    // BEFORE the readonly auto-allow so even Read("~/.agim/env") is
    // rejected without prompting the user (operator might click
    // "approve" without realizing the output is about to land in a
    // public IM channel). No IM card, no opt-in path — the only way
    // to lift this gate is to edit src/core/sensitive-paths.ts.
    {
      const { checkSensitiveToolUse } = await import('./sensitive-paths.js')
      const guard = checkSensitiveToolUse(args.toolName, args.input)
      if (guard.deny) {
        this.metricsSnapshot.totalRequests++
        this.metricsSnapshot.totalResolved++
        this.metricsSnapshot.totalDenied++
        log.warn({
          event: 'approval.bus.sensitive_blocked',
          toolName: args.toolName,
          reqId: args.reqId,
          runId: args.runId,
          compositeKey: cKey,
          reason: guard.reason,
        }, 'tool call hard-denied: targets sensitive path')
        try {
          const { logAuditEvent } = await import('./audit-log.js')
          logAuditEvent({
            eventType: 'approval.deny',
            actor: `${args.ctx.platform}:${args.ctx.threadId}`,
            target: args.toolName,
            outcome: 'denied',
            details: { reqId: args.reqId, reason: 'sensitive_path', sensitive: guard.reason },
          })
        } catch { /* best-effort */ }
        const decision: Decision = {
          behavior: 'deny',
          message: `🛑 已拒绝：该工具调用尝试访问敏感路径。\n   原因：${guard.reason ?? 'protected resource'}\n   即便管理员同意，此请求也不会被放行 — 请改用 IM 外的安全通道传递这些内容。`,
        }
        if ('socket' in args.transport) {
          this.sendDecision(args.transport.socket, args.reqId, decision)
        } else {
          try { args.transport.dispatch(decision) } catch (err) {
            log.warn({ event: 'approval.bus.dispatch_failed', reqId: args.reqId, err: String(err) })
          }
        }
        return
      }
    }

    // Readonly auto-allow short-circuit. Must come BEFORE pending registration
    // / notifier so it costs zero IM round-trips. Counts toward totals so the
    // metrics dashboard still reflects activity, but never fires the SSE
    // event-bus or notifier — readonly calls are deliberately invisible.
    if (!args.requiresExplicitDecision && READONLY_TOOLS.has(args.toolName) && this.isReadonlyAutoAllowEnabled(cKey)) {
      this.metricsSnapshot.totalRequests++
      this.metricsSnapshot.totalResolved++
      this.metricsSnapshot.totalAllowed++
      this.metricsSnapshot.totalReadonlyAutoAllowed++
      log.info({
        event: 'approval.bus.readonly_auto_allow',
        toolName: args.toolName,
        reqId: args.reqId,
        runId: args.runId,
        compositeKey: cKey,
      })
      const decision: Decision = { behavior: 'allow' }
      if ('socket' in args.transport) {
        this.sendDecision(args.transport.socket, args.reqId, decision)
      } else {
        try { args.transport.dispatch(decision) } catch (err) {
          log.warn({ event: 'approval.bus.dispatch_failed', reqId: args.reqId, err: String(err) })
        }
      }
      return
    }

    // Subagent proxy-approve: callDepth>0 means a nested worker. The
    // parent already owns the user turn — auto-allow on the user's behalf
    // (after sensitive-path hard-deny above). Opt out of the card for
    // requiresExplicitDecision tools still (e.g. plan-exit).
    const subagentDepth = typeof args.ctx.callDepth === 'number' ? args.ctx.callDepth : 0
    if (!args.requiresExplicitDecision && subagentDepth > 0) {
      try {
        const { checkToolUse } = await import('./self-protect.js')
        const selfGuard = checkToolUse(args.toolName, args.input)
        if (selfGuard) {
          this.metricsSnapshot.totalRequests++
          this.metricsSnapshot.totalResolved++
          this.metricsSnapshot.totalDenied++
          const decision: Decision = { behavior: 'deny', message: selfGuard.message }
          if ('socket' in args.transport) {
            this.sendDecision(args.transport.socket, args.reqId, decision)
          } else {
            try { args.transport.dispatch(decision) } catch (e) {
              log.warn({ event: 'approval.bus.dispatch_failed', reqId: args.reqId, err: String(e) })
            }
          }
          return
        }
      } catch { /* self-protect best-effort; allow if import fails */ }
      this.metricsSnapshot.totalRequests++
      this.metricsSnapshot.totalResolved++
      this.metricsSnapshot.totalAllowed++
      log.info({
        event: 'approval.bus.subagent_auto_approve',
        toolName: args.toolName,
        reqId: args.reqId,
        runId: args.runId,
        callDepth: subagentDepth,
        compositeKey: cKey,
      }, 'Subagent tool auto-approved on behalf of user')
      const decision: Decision = { behavior: 'allow' }
      if ('socket' in args.transport) {
        this.sendDecision(args.transport.socket, args.reqId, decision)
      } else {
        try { args.transport.dispatch(decision) } catch (err) {
          log.warn({ event: 'approval.bus.dispatch_failed', reqId: args.reqId, err: String(err) })
        }
      }
      return
    }

    // AGIM_AUTO_APPROVE — immediate allow without IM card or timeout.
    // Fires after sensitive-path hard-deny (above) and self-protect
    // (inline below). Skips the notifier entirely so we must run
    // self-protect here rather than relying on approval-router.
    // isAutoApproveEffective() also gates open-IM + empty allowlist.
    if (!args.requiresExplicitDecision && isAutoApproveEffective()) {
      try {
        const { checkToolUse } = await import('./self-protect.js')
        const selfGuard = checkToolUse(args.toolName, args.input)
        if (selfGuard) {
          this.metricsSnapshot.totalRequests++
          this.metricsSnapshot.totalResolved++
          this.metricsSnapshot.totalDenied++
          const decision: Decision = { behavior: 'deny', message: selfGuard.message }
          if ('socket' in args.transport) {
            this.sendDecision(args.transport.socket, args.reqId, decision)
          } else {
            try { args.transport.dispatch(decision) } catch (e) {
              log.warn({ event: 'approval.bus.dispatch_failed', reqId: args.reqId, err: String(e) })
            }
          }
          return
        }
      } catch { /* self-protect best-effort; allow if import fails */ }
      this.metricsSnapshot.totalRequests++
      this.metricsSnapshot.totalResolved++
      this.metricsSnapshot.totalAllowed++
      log.info({
        event: 'approval.bus.auto_approve',
        toolName: args.toolName,
        reqId: args.reqId,
        runId: args.runId,
        compositeKey: cKey,
      })
      const decision: Decision = { behavior: 'allow' }
      if ('socket' in args.transport) {
        this.sendDecision(args.transport.socket, args.reqId, decision)
      } else {
        try { args.transport.dispatch(decision) } catch (err) {
          log.warn({ event: 'approval.bus.dispatch_failed', reqId: args.reqId, err: String(err) })
        }
      }
      return
    }

    const ruleKey = autoAllowRuleKey(args.toolName, fingerprint)
    // Remembered rules may apply even for explicit-decision tools when the
    // caller opted into session pinning (e.g. unconfined agim_exec). Global
    // AGIM_AUTO_APPROVE still cannot skip the first card.
    const isAutoAllow = (
      !args.requiresExplicitDecision
      || allowSessionPin
    ) && (this.autoAllowByThread.get(cKey)?.has(ruleKey) ?? false)
    // Grace mode must use autoAllowGraceMs even when the caller passed a
    // long first-ask budget (e.g. confirmUnconfinedGoalExec /
    // complete_goal via timeoutMs). Otherwise the SPA countdown hits
    // "Auto-allowing now…" at graceSeconds while the bus timer still
    // waits minutes — the dock never receives approval-card-edit.
    const timeoutMs = isAutoAllow
      ? this.autoAllowGraceMs
      : (typeof args.timeoutMs === 'number' && args.timeoutMs > 0
          ? args.timeoutMs
          : this.approvalTimeoutMs)

    const transport = args.transport
    const pending: PendingApproval = {
      runId: args.runId,
      reqId: args.reqId,
      toolName: args.toolName,
      threadId: args.ctx.threadId,
      compositeKey: cKey,
      platform: args.ctx.platform,
      approverUserId: args.ctx.userId,
      fingerprint,
      input: args.input,
      registeredAt: Date.now(),
      socket: 'socket' in transport ? transport.socket : undefined,
      dispatch: 'dispatch' in transport ? transport.dispatch : undefined,
      resolved: false,
      autoAllow: isAutoAllow,
      requiresExplicitDecision: args.requiresExplicitDecision === true,
      allowSessionPin,
      timer: setTimeout(() => {
        // Grace-mode expiry always allows — even for pinnable explicit tools
        // that previously seeded a remembered rule.
        if (isAutoAllow) {
          this.cancelPending(pending, { behavior: 'allow' }, 'timeout')
        } else if (args.requiresExplicitDecision) {
          this.cancelPending(pending, { behavior: 'deny', message: 'explicit approval timeout' }, 'timeout')
        } else if (isTimeoutDefaultAllow()) {
          this.cancelPending(pending, { behavior: 'allow' }, 'timeout')
        } else {
          this.cancelPending(pending, { behavior: 'deny', message: 'approval timeout' }, 'timeout')
        }
      }, timeoutMs),
    }
    // v1.3.7 (F8) — enforce the pending cap BEFORE inserting the new entry.
    // Evict the oldest unresolved request (deny) so a flood can't grow the
    // maps without bound. The new request always gets a slot.
    if (this.pendingById.size >= MAX_PENDING_APPROVALS) {
      evictOldestPending(this.pendingById, MAX_PENDING_APPROVALS, (p) => {
        this.cancelPending(p, { behavior: 'deny', message: 'approval evicted: too many pending approvals' }, 'timeout')
      })
    }
    this.pendingById.set(args.reqId, pending)
    const q = this.pendingByThread.get(cKey) ?? []
    q.push(pending)
    this.pendingByThread.set(cKey, q)
    this.metricsSnapshot.totalRequests++

    // Event-bus fan-out so the dashboard's /events SSE consumer can pop
    // up an "approval pending" indicator without waiting on /api/approvals
    // poll. publish() swallows listener errors — never breaks the bus.
    eventBus.publish({
      type: 'approval',
      phase: 'requested',
      reqId: args.reqId,
      threadId: args.ctx.threadId,
      platform: args.ctx.platform,
      toolName: args.toolName,
    })

    log.info({
      event: 'approval.bus.request',
      runId: args.runId, reqId: args.reqId, toolName: args.toolName,
      threadId: args.ctx.threadId, autoAllow: isAutoAllow,
      transport: 'socket' in transport ? 'socket' : 'synthetic',
    })

    try {
      await this.notifier?.({
        runId: args.runId, reqId: args.reqId, toolName: args.toolName,
        input: args.input, toolUseId: args.toolUseId, ctx: args.ctx,
        ...(isAutoAllow ? { autoAllow: { graceMs: this.autoAllowGraceMs } } : {}),
        ...(args.requiresExplicitDecision ? { requiresExplicitDecision: true } : {}),
        ...(allowSessionPin ? { allowSessionPin: true } : {}),
      })
    } catch (err) {
      log.error({ event: 'approval.bus.notifier_error', reqId: args.reqId, err: String(err) })
      // Forward the actual error message to the agent so users see meaningful
      // text — most notably self-protect's "🛑 检测到尝试…请改用 /restart"
      // redirect, which was previously swallowed and replaced with a useless
      // "notifier error". For non-Error throws we keep the old fallback.
      const errMsg = err instanceof Error && err.message ? err.message : 'notifier error'
      this.cancelPending(pending, { behavior: 'deny', message: errMsg }, 'notifier-error')
    }
  }


  private cancelPending(p: PendingApproval, decision: Decision, cause: ResolutionCause = 'sidecar-disconnect'): void {
    if (p.resolved) return
    p.resolved = true
    clearTimeout(p.timer)

    // "Allow all" is never meaningful for hard one-shot transitions (plan
    // exit / complete_goal). Pinnable explicit tools (unconfined exec) may
    // seed a remembered rule via autoAllowFurther.
    if (
      p.requiresExplicitDecision
      && !p.allowSessionPin
      && decision.behavior === 'allow'
      && decision.autoAllowFurther
    ) {
      decision = {
        behavior: 'allow',
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      }
    }

    // M14: account for the resolution. Bucket into exactly ONE of
    // allowed / denied / timedOut so the three sub-counters sum to
    // totalResolved (Prometheus counters must monotonically increase;
    // double-counting could push a derived "allow = resolved-deny-timeout"
    // negative, which Prom interprets as a counter reset). Timeouts win
    // over the wire decision so an auto-allow grace expiry counts as
    // "timeout" (we said yes by default), distinct from "user said yes",
    // and a normal timeout-deny counts as "timeout", not "deny".
    this.metricsSnapshot.totalResolved++
    let outcome: 'allow' | 'deny' | 'timeout'
    if (cause === 'timeout') {
      this.metricsSnapshot.totalTimedOut++
      outcome = 'timeout'
    } else if (decision.behavior === 'deny') {
      this.metricsSnapshot.totalDenied++
      outcome = 'deny'
    } else {
      this.metricsSnapshot.totalAllowed++
      outcome = 'allow'
    }

    // Event-bus fan-out (dashboard SSE). Publish post-counter-update so a
    // metrics-snapshot consumer that reads on a 'resolved' event sees the
    // already-incremented counter.
    eventBus.publish({
      type: 'approval',
      phase: 'resolved',
      reqId: p.reqId,
      threadId: p.threadId,
      platform: p.platform,
      toolName: p.toolName,
      outcome,
    })

    // The "register on allow+all" side-effect lives here (covers any path
    // through cancelPending — both resolvePending and the grace timer).
    // The "revoke on user-deny" side-effect lives in resolvePending instead,
    // so non-user denies (run terminated, sidecar disconnect, shutdown)
    // don't accidentally clear rules the user still wants.
    if (decision.behavior === 'allow' && decision.autoAllowFurther) {
      addAutoAllowRule(this.autoAllowByThread, p.compositeKey, p.toolName, p.fingerprint)
    }

    if (p.dispatch) {
      // Synthetic path (opencode HTTP bridge). Caller owns the wire — they
      // translate Decision → their backend's reply schema. Errors thrown
      // here are isolated; the bus just logs.
      try {
        p.dispatch(decision)
      } catch (err) {
        log.warn({ event: 'approval.bus.dispatch_error', reqId: p.reqId, err: String(err) })
      }
    } else if (p.socket) {
      this.sendDecision(p.socket, p.reqId, decision)
    }
    // (Neither set is impossible — _registerPending guarantees one of the two.)
    removePending(p, this.pendingById, this.pendingByThread)

    // Fire resolution listener last so subscribers see fully-cleaned state
    // (pending already removed, rules already updated). Listener errors are
    // isolated — the bus must not crash on a bad subscriber.
    if (this.resolutionListener) {
      try {
        this.resolutionListener({
          reqId: p.reqId,
          runId: p.runId,
          threadId: p.threadId,
          platform: p.platform,
          toolName: p.toolName,
          fingerprint: p.fingerprint,
          decision,
          wasAutoAllow: p.autoAllow,
          cause,
        })
      } catch (err) {
        log.warn({ event: 'approval.bus.listener_error', reqId: p.reqId, err: String(err) })
      }
    }
  }

  private sendDecision(socket: Socket, reqId: string, decision: Decision): void {
    if (!socket.writable) {
      // Silent drop — agent never gets the decision and hangs until its own
      // MCP-side timeout. Log loudly so users diagnosing "auto-allow showed
      // the card but didn't fire" (and similar "approval landed but tool
      // didn't run" reports) have a breadcrumb. Most often happens when the
      // sidecar socket entered half-closed state between timer fire and
      // write (e.g. claude process exited a few ms before grace timer
      // expiry).
      log.warn({
        event: 'approval.bus.send_dropped',
        reqId,
        decision: decision.behavior,
        reason: 'socket-not-writable',
      }, 'cannot deliver decision: sidecar socket no longer writable')
      return
    }
    // Strip internal-only flags (e.g. autoAllowFurther) — sidecar only
    // understands the wire schema.
    const wire: Record<string, unknown> = { v: 1, type: 'decision', reqId, behavior: decision.behavior }
    if (decision.behavior === 'allow' && decision.updatedInput) {
      wire.updatedInput = decision.updatedInput
    } else if (decision.behavior === 'deny' && decision.message) {
      wire.message = decision.message
    }
    const payload = `${JSON.stringify(wire)}\n`
    socket.write(payload, (err) => {
      if (err) log.warn({ event: 'approval.bus.write_failed', reqId, err: String(err) })
    })
  }
}

function defaultSocketPath(): string {
  // 16 random bytes (32 hex chars) — defeats path prediction attacks that the
  // earlier `${pid}-${Date.now().toString(36)}` form was vulnerable to in
  // multi-tenant containers where pid is often 1 and the timestamp window
  // is small. With 128 bits of entropy a TOCTOU pre-occupy attempt is
  // statistically infeasible.
  return join(tmpdir(), `agim-approval-${randomBytes(16).toString('hex')}.sock`)
}

/** 进程级单例。agim 启动时 await approvalBus.start() 一次。 */
export const approvalBus = new ApprovalBus()
