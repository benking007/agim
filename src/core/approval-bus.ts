// approval-bus — IM 端人工审批的进程内总线
//
// 角色：在 im-hub 主进程里跑一个 unix socket 服务，等 claude 子进程的
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

import { createServer, type Server, type Socket } from 'net'
import { unlink, stat as fsStat, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { logger as rootLogger } from './logger.js'
import { eventBus } from './event-bus.js'

const log = rootLogger.child({ component: 'approval-bus' })

// Bumped from 5 min to 30 min so slower IM channels (e.g. Telegram, where
// notifications can land minutes after the bot.api.sendMessage logs success)
// have time to round-trip a y/n reply. Aligned with Claude's own 30 min hard
// timeout so we never outlive the underlying agent process.
const DEFAULT_APPROVAL_TIMEOUT_MS = parseEnvMs(
  process.env.IMHUB_APPROVAL_TIMEOUT_MS,
  30 * 60 * 1000,
)
const DEFAULT_AUTO_ALLOW_GRACE_MS = 5 * 1000

function parseEnvMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}
const MAX_LINE_BYTES = 256 * 1024
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 4

/** Length of the input prefix used to fingerprint an auto-allow rule.
 *  `(toolName, input-prefix)` is the dedup key.
 *
 *  Bumped from 5 → 10 (M13). 5 collapsed `bash::git s` so the rule
 *  matched `git status` AND `git stash` AND `git submodule update` — far
 *  broader than users meant when they OK'd a single command. 10 keeps
 *  the three common families distinct (`git status` ≠ `git stash` ≠
 *  `git submo`) while still grouping benign variations of the same
 *  operation (e.g. `git status` ≈ `git status -s`).
 *
 *  Why not longer? Most realistic commands are 6–14 chars, and pushing
 *  past 10 means even `git status` vs `git status -s` are treated as
 *  distinct, defeating the "approve once for variants" UX. 10 is the
 *  sweet spot per CR-2026-05-06. */
const AUTO_ALLOW_PREFIX_LEN = 10

export interface RunContext {
  threadId: string
  platform: string
  userId: string
  channelId: string
}

/** Wire-format decision sent back to the sidecar. `autoAllowFurther` is
 *  internal-only — `sendDecision` strips it before serializing. */
export type Decision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; autoAllowFurther?: boolean }
  | { behavior: 'deny'; message?: string }

export interface ApprovalNotification {
  runId: string
  reqId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  ctx: RunContext
  /** Present iff this request matched a per-thread auto-allow rule. The
   *  notifier should render a softer prompt ("⏱ 自动放行中, 5s 内回 n 可拒绝")
   *  instead of the regular y/n one — the bus will allow on timer expiry,
   *  unless the user actively denies first. */
  autoAllow?: { graceMs: number }
}

/** Notifier 只负责"通知 IM 推卡片/消息"。不要在这里返回决策；决策走 resolvePending。 */
export type ApprovalNotifier = (n: ApprovalNotification) => Promise<void>

/** Snapshot returned by {@link ApprovalBus.resolvePending} so the router can
 *  send the user a confirmation receipt ("✅ 已批准并启用自动放行 …" or
 *  "❌ 已拒绝并撤销自动放行 …") without re-scanning bus internals. */
export interface ResolvedInfo {
  reqId: string
  runId: string
  threadId: string
  platform: string
  toolName: string
  /** Same fingerprint the bus uses for the auto-allow rule key. */
  fingerprint: string
  /** True iff the resolved pending had been created in auto-allow grace
   *  mode — i.e. matched an existing rule. Lets the router distinguish
   *  "user denied a normal prompt" from "user denied an auto-allow prompt
   *  (which also revoked the rule)". */
  wasAutoAllow: boolean
}

/** Why an approval was resolved. Used by ResolutionListener consumers (e.g.
 *  approval-router) to decide whether to edit a UI card to "expired" — only
 *  non-`user` causes need cleanup, since the user-driven path (button click /
 *  text reply) edits the card itself before the listener fires. */
export type ResolutionCause =
  | 'user'             // explicit decision via resolvePending
  | 'timeout'          // bus timer fired — auto-allow grace expiry (allow) or normal timeout (deny)
  | 'sidecar-disconnect'
  | 'run-terminated'
  | 'shutdown'
  | 'notifier-error'

/** Fired exactly once per pending when it transitions from pending → resolved.
 *  Mirrors the wire decision sent to sidecar/dispatch but adds context (cause,
 *  threadId, platform) so listeners can route side-effects without scanning
 *  bus internals. Synchronous; listener errors are logged + swallowed. */
export interface ResolutionEvent {
  reqId: string
  runId: string
  threadId: string
  platform: string
  toolName: string
  fingerprint: string
  decision: Decision
  wasAutoAllow: boolean
  cause: ResolutionCause
}

export type ResolutionListener = (e: ResolutionEvent) => void

/** Composite key that prevents cross-platform/channel thread collisions. */
export function threadKey(platform: string, channelId: string, threadId: string): string {
  return `${platform}:${channelId}:${threadId}`
}

interface PendingApproval {
  runId: string
  reqId: string
  toolName: string
  threadId: string
  /** `platform:channelId:threadId` — used as the Map key for pendingByThread
   *  and autoAllowByThread so different platforms/channels don't collide. */
  compositeKey: string
  /** Cached at registration so cancelPending can fire ResolutionListener with
   *  a valid platform even when the underlying runContext has already been
   *  cleared (e.g. unregisterRun deletes the context BEFORE cancelling). */
  platform: string
  /** Truncated input fingerprint used for auto-allow lookups + revocation. */
  fingerprint: string
  /** Original tool input — kept verbatim so dashboard / `listPending` can
   *  surface a useful preview to operators. Never sent over the wire by
   *  the bus itself; sidecar already has the original. */
  input: Record<string, unknown>
  /** Wall-clock ms when the pending was registered. Used by listPending
   *  to compute age; zero in pre-existing rehydrated state (impossible
   *  in practice — bus is process-local). */
  registeredAt: number
  /** Set when the pending was created from a unix-socket sidecar (Claude
   *  path). cancelPending writes the decision back over this socket. Either
   *  `socket` or `dispatch` must be set, never both. */
  socket?: Socket
  /** Set when the pending was created via {@link ApprovalBus.registerSyntheticPending}
   *  (opencode HTTP path, P2). cancelPending invokes this callback instead
   *  of writing to a socket — the caller is responsible for delivering the
   *  decision to its own backend (e.g. POST /permission/:id/reply). Errors
   *  thrown from dispatch are logged, never propagated. */
  dispatch?: (decision: Decision) => void
  timer: ReturnType<typeof setTimeout>
  resolved: boolean
  /** When true, this pending was created in auto-allow mode: timer expiry
   *  resolves to allow rather than deny, and an explicit deny revokes the
   *  matching auto-allow rule. */
  autoAllow: boolean
}

export interface ApprovalBusOptions {
  approvalTimeoutMs?: number
  /** Window between sending the auto-allow notice and auto-resolving as
   *  allow (when the user doesn't actively deny in the meantime). */
  autoAllowGraceMs?: number
}

export class ApprovalBus {
  private server: Server | null = null
  private socketPath: string | null = null
  private readonly approvalTimeoutMs: number
  private readonly autoAllowGraceMs: number

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
    // Reset lifetime counters so a restarted process starts at 0 — keeps
    // `rate(im_hub_approval_requests_total)` correct without ops needing
    // to track process restarts in the alert query.
    this.metricsSnapshot = { totalRequests: 0, totalResolved: 0, totalAllowed: 0, totalDenied: 0, totalTimedOut: 0 }

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

  /** Check if there are pending approvals for the given key (composite or plain threadId for backward compat). */
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
  /** Resolve the FIFO head for a thread key. Accepts either a composite key
   *  (`platform:channelId:threadId`) or a plain threadId for backward compat. */
  resolvePending(key: string, decision: Decision): ResolvedInfo | null {
    const q = this.pendingByThread.get(key)
    const head = q?.[0]
    if (!head) return null
    return this._resolveTarget(head, decision)
  }

  /**
   * Resolve a specific pending approval identified by reqId. Used by button
   * callbacks and the dashboard where the UI element carries the exact reqId,
   * avoiding the FIFO head-of-thread ambiguity of resolvePending().
   */
  resolvePendingByReqId(reqId: string, decision: Decision): ResolvedInfo | null {
    const target = this.pendingById.get(reqId)
    if (!target || target.resolved) return null
    return this._resolveTarget(target, decision)
  }

  private _resolveTarget(target: PendingApproval, decision: Decision): ResolvedInfo {
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
      this.removeAutoAllowRule(target.compositeKey, target.toolName, target.fingerprint)
    }
    this.cancelPending(target, decision, 'user')
    return info
  }

  /** Drop every auto-allow rule registered for this thread. Called from
   *  session.resetConversation so `/new` truly returns to "ask every time".
   *  Accepts composite key or plain threadId for backward compat. */
  clearAutoAllowForThread(key: string): void {
    this.autoAllowByThread.delete(key)
  }

  /** Test/diagnostic helper — current rule keys for a thread. */
  getAutoAllowKeys(key: string): string[] {
    return [...(this.autoAllowByThread.get(key) ?? [])]
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
  } {
    return {
      pending: this.pendingById.size,
      totalRequests: this.metricsSnapshot.totalRequests,
      totalResolved: this.metricsSnapshot.totalResolved,
      totalAllowed: this.metricsSnapshot.totalAllowed,
      totalDenied: this.metricsSnapshot.totalDenied,
      totalTimedOut: this.metricsSnapshot.totalTimedOut,
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
          socket.write(JSON.stringify({ v: 1, type: 'fatal', reason: 'buffer overflow' }) + '\n')
          socket.end()
        } catch {
          socket.destroy()
        }
        return
      }
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
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
    log.warn({ event: 'approval.bus.unknown_type', type: m.type })
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
    transport: { socket: Socket } | { dispatch: (decision: Decision) => void }
  }): Promise<void> {
    const fingerprint = inputFingerprint(args.input)
    const cKey = threadKey(args.ctx.platform, args.ctx.channelId, args.ctx.threadId)
    const ruleKey = autoAllowRuleKey(args.toolName, fingerprint)
    const isAutoAllow = this.autoAllowByThread.get(cKey)?.has(ruleKey) ?? false
    const timeoutMs = isAutoAllow ? this.autoAllowGraceMs : this.approvalTimeoutMs

    const transport = args.transport
    const pending: PendingApproval = {
      runId: args.runId,
      reqId: args.reqId,
      toolName: args.toolName,
      threadId: args.ctx.threadId,
      compositeKey: cKey,
      platform: args.ctx.platform,
      fingerprint,
      input: args.input,
      registeredAt: Date.now(),
      socket: 'socket' in transport ? transport.socket : undefined,
      dispatch: 'dispatch' in transport ? transport.dispatch : undefined,
      resolved: false,
      autoAllow: isAutoAllow,
      timer: setTimeout(() => {
        if (isAutoAllow) {
          this.cancelPending(pending, { behavior: 'allow' }, 'timeout')
        } else {
          this.cancelPending(pending, { behavior: 'deny', message: 'approval timeout' }, 'timeout')
        }
      }, timeoutMs),
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
      await this.notifier!({
        runId: args.runId, reqId: args.reqId, toolName: args.toolName,
        input: args.input, toolUseId: args.toolUseId, ctx: args.ctx,
        ...(isAutoAllow ? { autoAllow: { graceMs: this.autoAllowGraceMs } } : {}),
      })
    } catch (err) {
      log.error({ event: 'approval.bus.notifier_error', reqId: args.reqId, err: String(err) })
      this.cancelPending(pending, { behavior: 'deny', message: 'notifier error' }, 'notifier-error')
    }
  }

  private cancelPending(p: PendingApproval, decision: Decision, cause: ResolutionCause = 'sidecar-disconnect'): void {
    if (p.resolved) return
    p.resolved = true
    clearTimeout(p.timer)

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
      this.addAutoAllowRule(p.compositeKey, p.toolName, p.fingerprint)
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
    this.removePending(p)

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

  private addAutoAllowRule(compositeKey: string, toolName: string, fingerprint: string): void {
    const key = autoAllowRuleKey(toolName, fingerprint)
    let set = this.autoAllowByThread.get(compositeKey)
    if (!set) { set = new Set(); this.autoAllowByThread.set(compositeKey, set) }
    set.add(key)
    log.info({ event: 'approval.bus.autoallow_added', compositeKey, toolName, fingerprint })
  }

  private removeAutoAllowRule(compositeKey: string, toolName: string, fingerprint: string): void {
    const key = autoAllowRuleKey(toolName, fingerprint)
    const set = this.autoAllowByThread.get(compositeKey)
    if (!set) return
    if (set.delete(key) && set.size === 0) this.autoAllowByThread.delete(compositeKey)
    log.info({ event: 'approval.bus.autoallow_removed', compositeKey, toolName, fingerprint })
  }

  private removePending(p: PendingApproval): void {
    this.pendingById.delete(p.reqId)
    const q = this.pendingByThread.get(p.compositeKey)
    if (!q) return
    const idx = q.indexOf(p)
    if (idx >= 0) q.splice(idx, 1)
    if (q.length === 0) this.pendingByThread.delete(p.compositeKey)
  }

  private sendDecision(socket: Socket, reqId: string, decision: Decision): void {
    if (!socket.writable) return
    // Strip internal-only flags (e.g. autoAllowFurther) — sidecar only
    // understands the wire schema.
    const wire: Record<string, unknown> = { v: 1, type: 'decision', reqId, behavior: decision.behavior }
    if (decision.behavior === 'allow' && decision.updatedInput) {
      wire.updatedInput = decision.updatedInput
    } else if (decision.behavior === 'deny' && decision.message) {
      wire.message = decision.message
    }
    const payload = JSON.stringify(wire) + '\n'
    socket.write(payload, (err) => {
      if (err) log.warn({ event: 'approval.bus.write_failed', reqId, err: String(err) })
    })
  }
}

function autoAllowRuleKey(toolName: string, fingerprint: string): string {
  return `${toolName}::${fingerprint}`
}

/**
 * Pick a stable, short prefix of the input as the auto-allow fingerprint.
 *
 * Strategy: try the field most users mean when they say "this kind of
 * call" for the common Claude tools (Bash → command, Write/Edit/Read →
 * file_path, etc.); fall back to a stringified snapshot. Always truncated
 * to AUTO_ALLOW_PREFIX_LEN so the rule covers small variations of the
 * same operation but not unrelated ones.
 */
function inputFingerprint(input: Record<string, unknown>): string {
  const FIELDS = ['command', 'file_path', 'path', 'url', 'pattern', 'query']
  for (const f of FIELDS) {
    const v = input[f]
    if (typeof v === 'string' && v.length > 0) {
      return v.slice(0, AUTO_ALLOW_PREFIX_LEN)
    }
  }
  let s: string
  try { s = JSON.stringify(input) } catch { s = '' }
  return s.slice(0, AUTO_ALLOW_PREFIX_LEN)
}

function defaultSocketPath(): string {
  // 16 random bytes (32 hex chars) — defeats path prediction attacks that the
  // earlier `${pid}-${Date.now().toString(36)}` form was vulnerable to in
  // multi-tenant containers where pid is often 1 and the timestamp window
  // is small. With 128 bits of entropy a TOCTOU pre-occupy attempt is
  // statistically infeasible.
  return join(tmpdir(), `imhub-approval-${randomBytes(16).toString('hex')}.sock`)
}

/** 进程级单例。im-hub 启动时 await approvalBus.start() 一次。 */
export const approvalBus = new ApprovalBus()
