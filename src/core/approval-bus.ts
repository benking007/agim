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
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { logger as rootLogger } from './logger.js'
import { eventBus } from './event-bus.js'

const log = rootLogger.child({ component: 'approval-bus' })

// Default 15 min — long enough for slower IM channels to round-trip
// a y/n reply. When AGIM_AUTO_APPROVE is on, this timeout is irrelevant
// (tools are approved immediately without waiting). This value only
// matters when auto-approve is off and a human is expected to respond.
const DEFAULT_APPROVAL_TIMEOUT_MS = parseEnvMs(
  process.env.AGIM_APPROVAL_TIMEOUT_MS,
  15 * 60 * 1000,
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

// AGIM_AUTO_APPROVE — first-class auto-approve switch. When enabled,
// tool calls are approved immediately after safety checks (sensitive-path
// hard-deny + self-protect), without sending an IM approval card or
// waiting for any timeout. The approval bus still runs so audit trail,
// metrics, and safety checks all remain active.
//
// Read per call (not cached at module load) so the Web Settings panel
// can hot-toggle it via handlePutEnv.
export function isAutoApproveEnabled(): boolean {
  const raw = (process.env.AGIM_AUTO_APPROVE ?? '').toLowerCase().trim()
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

// AGIM_TIMEOUT_DEFAULT=allow | deny (default deny). Decides what the bus
// returns when a pending approval times out without a human response.
// Only relevant when AGIM_AUTO_APPROVE is off (otherwise tools never
// reach the timeout path). Default 'deny' keeps mutating tools gated;
// set 'allow' for "user away" fallback mode.
//
// Read at every timer fire (not captured at module load) so the Web
// Settings card can hot-toggle it.
export function isTimeoutDefaultAllow(): boolean {
  return (process.env.AGIM_TIMEOUT_DEFAULT ?? 'deny').toLowerCase() === 'allow'
}

// R13 C1 — visibility for "user away" mode. When AGIM_TIMEOUT_DEFAULT is
// `allow`, every approval that times out without IM response auto-approves
// — that's a meaningful weakening of the human-in-the-loop guarantee.
let _timeoutAllowHourlyTimer: ReturnType<typeof setInterval> | null = null

export function announceTimeoutDefaultIfAllow(): void {
  // Log auto-approve status at startup.
  if (isAutoApproveEnabled()) {
    log.info({
      event: 'approval.bus.auto_approve_enabled',
    }, 'AGIM_AUTO_APPROVE=on — tool calls auto-approved after safety checks')
    if (_timeoutAllowHourlyTimer) {
      clearInterval(_timeoutAllowHourlyTimer)
      _timeoutAllowHourlyTimer = null
    }
    return
  }

  if (!isTimeoutDefaultAllow()) {
    if (_timeoutAllowHourlyTimer) {
      clearInterval(_timeoutAllowHourlyTimer)
      _timeoutAllowHourlyTimer = null
    }
    return
  }
  const banner = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '⚠️  APPROVAL TIMEOUT POLICY: allow',
    '',
    '   AGIM_TIMEOUT_DEFAULT=allow → unresolved approvals auto-approve.',
    '   Human-in-the-loop oversight on Bash / Edit / Write is weakened.',
    '   Revert with: AGIM_TIMEOUT_DEFAULT=deny (or unset).',
    '   Prefer: AGIM_AUTO_APPROVE=1 for immediate auto-approve.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n')
  process.stdout.write(banner)
  log.warn({
    event: 'approval.bus.timeout_default_allow',
    msg: 'AGIM_TIMEOUT_DEFAULT=allow — approval timeouts auto-approve',
  })
  try {
    void (async () => {
      const { logAuditEvent } = await import('./audit-log.js')
      logAuditEvent({
        eventType: 'config.put',
        actor: 'system',
        target: 'approval.timeout_default',
        outcome: 'ok',
        details: { value: 'allow', startup: true },
      })
    })()
  } catch { /* best-effort */ }
  if (_timeoutAllowHourlyTimer === null) {
    _timeoutAllowHourlyTimer = setInterval(() => {
      if (!isTimeoutDefaultAllow()) {
        if (_timeoutAllowHourlyTimer) {
          clearInterval(_timeoutAllowHourlyTimer)
          _timeoutAllowHourlyTimer = null
        }
        return
      }
      log.warn({
        event: 'approval.bus.timeout_default_allow.reminder',
        msg: 'reminder: AGIM_TIMEOUT_DEFAULT=allow still in effect',
      })
    }, 60 * 60 * 1000)
    if (typeof _timeoutAllowHourlyTimer === 'object' && _timeoutAllowHourlyTimer
        && 'unref' in _timeoutAllowHourlyTimer) {
      (_timeoutAllowHourlyTimer as { unref: () => void }).unref()
    }
  }
}

/** Stop the C1 hourly reminder. Used by graceful shutdown + tests. */
export function stopTimeoutDefaultReminder(): void {
  if (_timeoutAllowHourlyTimer) {
    clearInterval(_timeoutAllowHourlyTimer)
    _timeoutAllowHourlyTimer = null
  }
}

/**
 * Tools whose contract is "read filesystem state, return it" — no writes,
 * no shell exec, no network. These short-circuit the approval flow with an
 * immediate `allow` and never reach the IM notifier. Saves the ~3–5s round
 * trip per call AND removes the noise of "🔐 Read /tmp/foo.txt y/n" cards
 * that LLMs spam during exploration.
 *
 * Conservative starting list — only tools whose name guarantees the
 * contract. Excluded on purpose:
 *  - `Bash` (cannot statically tell `cat` from `rm -rf /`)
 *  - `WebFetch` / `WebSearch` (outbound HTTP — leaks context, hits rate
 *    limits, has third-party side effects even if "readonly" locally)
 *  - any `mcp__*` (third-party MCP servers; arbitrary semantics)
 *
 * Per-thread opt-out: `/approval readonly off`. Global opt-out:
 * `AGIM_AUTOALLOW_READONLY=0`.
 */
const READONLY_TOOLS = new Set<string>([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
])

const READONLY_AUTO_ALLOW_GLOBAL_ENABLED =
  (process.env.AGIM_AUTOALLOW_READONLY ?? '1') !== '0'

function parseEnvMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}
const MAX_LINE_BYTES = 256 * 1024
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 4

/** Fallback prefix length for tools without a semantic key (Glob/Grep
 *  patterns, WebSearch queries, unknown tools). The mainline path uses
 *  per-tool semantic fingerprints — see inputFingerprint() — so this only
 *  governs the long tail. Kept at 10 for parity with the pre-semantic
 *  behavior. */
const AUTO_ALLOW_PREFIX_LEN = 10

export interface RunContext {
  threadId: string
  platform: string
  userId: string
  channelId: string
  /** A2A-L1: name of the agent this run is executing under (claude-code /
   *  opencode / codex / …). Adapters fill this when calling
   *  approvalBus.registerRun so bus.handleA2A can reject self-calls and
   *  audit can record the chain. Optional for legacy callers; the
   *  self-call check just no-ops when absent. */
  callerAgent?: string
  /** A2A-L1: this run's own call_depth. 0 for user-originated runs;
   *  bumped to caller.callDepth+1 when an A2A invocation spawns a new
   *  agent run. Used to enforce AGIM_A2A_MAX_DEPTH. */
  callDepth?: number
  /** A2A-L1: id of the inline-jobs row that's tracking this run, when
   *  the run was spawned from another agent's mcp__agim__call_agent
   *  call. Optional for top-level runs. */
  parentJobId?: number
  /** SEC: this run is executing under plan-mode (user did /plan on, so the
   *  parent agent runs read-only). Adapters set this when registering a run
   *  whose opts.planMode is true. bus.handleA2A propagates it to the callee
   *  so a plan-mode run can't delegate a write task to another agent that
   *  would launch with full write access — bypassing the user's intent.
   *  Mirrors a2a.ts / agim-dispatcher.ts (callerPlanMode) which already do
   *  this for their own spawn paths. */
  callerPlanMode?: boolean
  /** Filesystem cwd used by the running agent subprocess. Extension-based
   *  agents (PI, future custom-tool CLIs) use it when Agim proxies native
   *  write/exec tools on their behalf, so approved filesystem operations land
   *  in the same workspace the agent is reasoning about. */
  cwd?: string
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
    if (m.type === 'reminder') {
      await this.handleReminder(m, socket)
      return
    }
    if (m.type === 'memo') {
      await this.handleMemo(m, socket)
      return
    }
    if (m.type === 'a2a') {
      await this.handleA2A(m, socket)
      return
    }
    if (m.type === 'push') {
      await this.handlePush(m, socket)
      return
    }
    if (m.type === 'ask') {
      await this.handleAsk(m, socket)
      return
    }
    if (m.type === 'skill') {
      await this.handleSkill(m, socket)
      return
    }
    if (m.type === 'native_tool') {
      await this.handleNativeTool(m, socket)
      return
    }
    if (m.type === 'memory') {
      await this.handleMemory(m, socket)
      return
    }
    if (m.type === 'goal') {
      await this.handleGoal(m, socket)
      return
    }
    log.warn({ event: 'approval.bus.unknown_type', type: m.type })
  }

  /**
   * Handle an A2A call RPC sent by the MCP sidecar. Wire format:
   *
   *   {
   *     v: 1, type: 'a2a', reqId, runId,
   *     payload: { agent: string, prompt: string, timeoutMs?: number }
   *   }
   *
   * Response (sent via {@link sendA2AResult}):
   *
   *   { v: 1, type: 'a2a.result', reqId,
   *     ok: true,  result, jobId, agent, durationMs }
   *   | { v: 1, type: 'a2a.result', reqId,
   *       ok: false, error }
   *
   * Validation order:
   *   1. reqId/runId/payload shape — wire-level
   *   2. runId → RunContext (no _im_context fallback for A2A: a forged
   *      context could let a compromised callee escalate to a different
   *      user's workspace, and the cost is real money)
   *   3. agent + prompt presence
   *   4. self-call check (caller agent vs target agent)
   *   5. depth check (handled inside a2a.callAgentByName)
   */
  private async handleA2A(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}

    if (!reqId) {
      log.warn({ event: 'a2a.bus.missing_reqId' })
      return
    }
    if (!runId) {
      this.sendA2AResult(socket, reqId, { ok: false, error: 'missing runId' })
      return
    }
    const ctx = this.runContexts.get(runId)
    if (!ctx) {
      this.sendA2AResult(socket, reqId, { ok: false, error: `unknown runId: ${runId}` })
      return
    }
    const agentName = typeof payload.agent === 'string' ? payload.agent : ''
    const prompt    = typeof payload.prompt === 'string' ? payload.prompt : ''
    if (!agentName || !prompt) {
      this.sendA2AResult(socket, reqId, {
        ok: false, error: 'payload.agent and payload.prompt are required',
      })
      return
    }
    const timeoutMs = typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
      ? payload.timeoutMs : undefined

    // L2 — caller-supplied artifacts inputs + optional expectOutputs.
    // We forward as-is; callAgentByName / artifacts.ts validates shape
    // and returns a clean error for malformed entries.
    const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : undefined
    const inputs = rawInputs?.filter(
      (x): x is Parameters<typeof import('./a2a.js').callAgentByName>[3] extends infer T
        ? T extends { inputs?: (infer U)[] | undefined } ? U : never
        : never =>
        !!x && typeof x === 'object' && !Array.isArray(x)
        && typeof (x as Record<string, unknown>).name === 'string',
    )
    const rawExpect = Array.isArray(payload.expectOutputs) ? payload.expectOutputs : undefined
    const expectOutputs = rawExpect?.filter((s): s is string => typeof s === 'string')

    // Lazy-import so the bus module stays free of router/registry at load
    // time (matters for tests that mock route side effects).
    const { callAgentByName } = await import('./a2a.js')
    // Synthesize a minimal RouteContext from the RunContext. logger is a
    // child of the bus log so we get traceability without dragging the
    // cli's logger plumbing through the bus.
    const routeCtx = {
      threadId: ctx.threadId,
      channelId: ctx.channelId,
      platform: ctx.platform,
      defaultAgent: agentName,  // not strictly used by callAgentByName
      traceId: reqId,
      logger: log,
      userId: ctx.userId,
    } as Parameters<typeof callAgentByName>[2]
    const result = await callAgentByName(agentName, prompt, routeCtx, {
      callerAgent: ctx.callerAgent,
      callerDepth: ctx.callDepth ?? 0,
      parentJobId: ctx.parentJobId ?? null,
      // SEC: a plan-mode parent must not launch the callee with write access.
      ...(ctx.callerPlanMode ? { planMode: true } : {}),
      timeoutMs,
      ...(inputs && inputs.length > 0 ? { inputs } : {}),
      ...(expectOutputs && expectOutputs.length > 0 ? { expectOutputs } : {}),
    })
    if (result.ok) {
      this.sendA2AResult(socket, reqId, {
        ok: true, result: result.result, jobId: result.jobId,
        agent: result.agent, durationMs: result.durationMs,
        artifactsDir: result.artifactsDir,
        outputs: result.outputs,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      })
    } else {
      this.sendA2AResult(socket, reqId, { ok: false, error: result.error })
    }
  }

  private sendA2AResult(
    socket: Socket, reqId: string,
    res:
      | {
          ok: true;  result: string; jobId: number; agent: string; durationMs: number
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

  /**
   * Handle a reminder RPC sent by the MCP sidecar (mcp-approval-server.ts).
   * Same socket as approvals; different `type`. Two ways to identify the
   * IM thread:
   *
   *   1. runId → RunContext lookup (preferred — used by claude-code via
   *      --mcp-config env, and opencode stdio via per-spawn extraEnv)
   *   2. _im_context inline (fallback — used by opencode http where the
   *      MCP server is shared across sessions and per-spawn env can't be
   *      injected; the agent itself asserts the context)
   *
   * Path 2 is **single-user only** by design: a multi-tenant deployment
   * would let one user's agent forge reminders for another. Adapters that
   * want to use path 2 must opt in by sending `_im_context`. We log it
   * loudly so operators can audit.
   */
  private async handleReminder(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const op = typeof m.op === 'string' ? m.op : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}

    if (!reqId) {
      log.warn({ event: 'reminder.bus.missing_reqId' })
      return // can't reply without reqId
    }
    if (!op) {
      this.sendReminderResult(socket, reqId, { ok: false, error: 'invalid reminder message' })
      return
    }

    // Resolve context: runId path first, then inline _im_context fallback.
    let ctx: RunContext | null = null
    if (runId) {
      ctx = this.runContexts.get(runId) ?? null
    }
    if (!ctx) {
      // Try to extract _im_context from the payload itself (path 2)
      const inlineCtx = payload._im_context
      if (inlineCtx && typeof inlineCtx === 'object' && !Array.isArray(inlineCtx)) {
        const ic = inlineCtx as Record<string, unknown>
        if (typeof ic.platform === 'string' && typeof ic.threadId === 'string'
            && typeof ic.channelId === 'string') {
          ctx = {
            platform: ic.platform,
            threadId: ic.threadId,
            channelId: ic.channelId,
            userId: typeof ic.userId === 'string' ? ic.userId : '',
          }
          log.info({
            event: 'reminder.bus.inline_ctx',
            platform: ctx.platform, threadId: ctx.threadId, runId,
          }, 'reminder using agent-asserted _im_context (single-user mode)')
          // Strip _im_context from payload so it doesn't leak into the
          // RPC handler's field validation.
          delete payload._im_context
        }
      }
    }

    if (!ctx) {
      this.sendReminderResult(socket, reqId, {
        ok: false,
        error: `unknown runId: ${runId} (and no _im_context fallback provided)`,
      })
      return
    }
    // Lazy-import so the bus module stays free of reminders.ts at load time
    // (matters for tests that mock reminder side-effects).
    const { handleReminderOp } = await import('./reminder-rpc.js')
    const result = await handleReminderOp(op, payload, ctx)
    this.sendReminderResult(socket, reqId, result)
  }

  private sendReminderResult(
    socket: Socket, reqId: string,
    result: { ok: true; result: unknown } | { ok: false; error: string },
  ): void {
    if (!socket.writable) return
    const wire: Record<string, unknown> = { v: 1, type: 'reminder.result', reqId, ok: result.ok }
    if (result.ok) wire.result = result.result
    else wire.error = result.error
    socket.write(`${JSON.stringify(wire)}\n`, (err) => {
      if (err) log.warn({ event: 'reminder.bus.write_failed', reqId, err: String(err) })
    })
  }

  /**
   * Handle a memo RPC from the MCP sidecar — same socket as approvals and
   * reminders, different `type`. Mirror of {@link handleReminder}. Both
   * runId-resolved context and the inline `_im_context` fallback are
   * supported, with the same single-user-only caveat for path 2.
   *
   * Wire history: pre-0.2.42 this was `type: 'location'` carrying geo-only
   * memos; 0.2.42 generalized to 5W1H memos and renamed the wire type.
   */
  private async handleMemo(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const op = typeof m.op === 'string' ? m.op : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}

    if (!reqId) {
      log.warn({ event: 'memo.bus.missing_reqId' })
      return
    }
    if (!op) {
      this.sendMemoResult(socket, reqId, { ok: false, error: 'invalid memo message' })
      return
    }

    let ctx: RunContext | null = null
    if (runId) ctx = this.runContexts.get(runId) ?? null
    if (!ctx) {
      const inlineCtx = payload._im_context
      if (inlineCtx && typeof inlineCtx === 'object' && !Array.isArray(inlineCtx)) {
        const ic = inlineCtx as Record<string, unknown>
        if (typeof ic.platform === 'string' && typeof ic.threadId === 'string'
            && typeof ic.channelId === 'string') {
          ctx = {
            platform: ic.platform,
            threadId: ic.threadId,
            channelId: ic.channelId,
            userId: typeof ic.userId === 'string' ? ic.userId : '',
          }
          log.info({
            event: 'memo.bus.inline_ctx',
            platform: ctx.platform, threadId: ctx.threadId, runId,
          }, 'memo using agent-asserted _im_context (single-user mode)')
          delete payload._im_context
        }
      }
    }

    if (!ctx) {
      this.sendMemoResult(socket, reqId, {
        ok: false,
        error: `unknown runId: ${runId} (and no _im_context fallback provided)`,
      })
      return
    }
    const { handleMemoOp } = await import('./memo-rpc.js')
    const result = await handleMemoOp(op, payload, ctx)
    this.sendMemoResult(socket, reqId, result)
  }

  private sendMemoResult(
    socket: Socket, reqId: string,
    result: { ok: true; result: unknown } | { ok: false; error: string },
  ): void {
    if (!socket.writable) return
    const wire: Record<string, unknown> = { v: 1, type: 'memo.result', reqId, ok: result.ok }
    if (result.ok) wire.result = result.result
    else wire.error = result.error
    socket.write(`${JSON.stringify(wire)}\n`, (err) => {
      if (err) log.warn({ event: 'memo.bus.write_failed', reqId, err: String(err) })
    })
  }

  /**
   * v1.3 — agent-initiated push (`mcp__agim__push_message`). Wire format:
   *   { v: 1, type: 'push', runId, reqId, payload: { text, toThread?, kind? } }
   * Response: { v: 1, type: 'push.result', reqId, ok, result?, error? }
   *
   * Context resolution mirrors handleReminder / handleMemo: runId → ctx
   * with an inline _im_context fallback for single-user MCP setups.
   * Per-user rate limit + cross-thread gating are enforced in push-rpc.
   */
  private async handlePush(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}
    if (!reqId) { log.warn({ event: 'push.bus.missing_reqId' }); return }
    // _im_context fallback is intentionally NOT supported for push. push
    // sends a message to a user's IM thread — accepting an agent-asserted
    // identity would let any caller spoof userId and push to other users
    // when MCP daemons are shared across users (e.g. opencode's single
    // long-lived MCP process). Force runId resolution.
    if (payload._im_context) delete payload._im_context
    const ctx: RunContext | null = runId ? (this.runContexts.get(runId) ?? null) : null
    if (!ctx) {
      this.sendPushResult(socket, reqId, {
        ok: false, error: `unknown runId: ${runId} — push requires a live runContext (no _im_context fallback)`,
      })
      return
    }

    const { handlePushOp } = await import('./push-rpc.js')
    const result = await handlePushOp(payload as import('./push-rpc.js').PushPayload, ctx)
    this.sendPushResult(socket, reqId, result)
  }

  private sendPushResult(
    socket: Socket, reqId: string,
    result: { ok: true; result: unknown } | { ok: false; error: string },
  ): void {
    if (!socket.writable) return
    const wire: Record<string, unknown> = { v: 1, type: 'push.result', reqId, ok: result.ok }
    if (result.ok) wire.result = result.result
    else wire.error = result.error
    socket.write(`${JSON.stringify(wire)}\n`, (err) => {
      if (err) log.warn({ event: 'push.bus.write_failed', reqId, err: String(err) })
    })
  }

  /**
   * P0 #5 — agent-driven structured ask. Wire format:
   *   { v:1, type:'ask', runId, reqId, payload:{question, choices, timeoutSec?, allowTextReply?} }
   * Response: { v:1, type:'ask.result', reqId, ok, result?, error?, reason? }
   *
   * Like push, runId resolution is REQUIRED — no _im_context fallback,
   * because the ask delivers a question to a specific IM user thread
   * and accepting an agent-asserted thread would let any caller spoof
   * a different user's context.
   */
  private async handleAsk(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}
    if (!reqId) { log.warn({ event: 'ask.bus.missing_reqId' }); return }
    if (payload._im_context) delete payload._im_context
    const ctx: RunContext | null = runId ? (this.runContexts.get(runId) ?? null) : null
    if (!ctx) {
      this.sendAskResult(socket, reqId, {
        ok: false,
        error: `unknown runId: ${runId} — ask_user requires a live runContext (no _im_context fallback)`,
        reason: 'invalid',
      })
      return
    }
    const { handleAskOp } = await import('./ask-user-rpc.js')
    const result = await handleAskOp(payload as import('./ask-user-rpc.js').AskPayload, ctx)
    this.sendAskResult(socket, reqId, result)
  }

  private sendAskResult(
    socket: Socket, reqId: string,
    result: import('./ask-user-rpc.js').AskResult,
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

  /**
   * Stage 3 / P0 #3 — skills loader RPC. agim-owned skills are
   * injected as a tier-1 summary into every prompt; this RPC lets the
   * agent pull the tier-2 body on-demand. Same _im_context-free
   * posture as push: skills are agim-global, no per-user scoping.
   *   { v:1, type:'skill', reqId, payload:{op, name?} }
   *   { v:1, type:'skill.result', reqId, ok, result?, error? }
   */
  private async handleSkill(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}
    if (!reqId) { log.warn({ event: 'skill.bus.missing_reqId' }); return }
    const { handleSkillsOp } = await import('./skills-rpc.js')
    const result = await handleSkillsOp(payload as import('./skills-rpc.js').SkillsPayload)
    this.sendSkillResult(socket, reqId, result)
  }

  private sendSkillResult(
    socket: Socket, reqId: string,
    result: import('./skills-rpc.js').SkillsResult,
  ): void {
    if (!socket.writable) return
    const wire: Record<string, unknown> = { v: 1, type: 'skill.result', reqId, ok: result.ok }
    if (result.ok) wire.result = result.result
    else wire.error = result.error
    socket.write(`${JSON.stringify(wire)}\n`, (err) => {
      if (err) log.warn({ event: 'skill.bus.write_failed', reqId, err: String(err) })
    })
  }

  /**
   * Read-only Agim native tool bridge for extension-based agents such as PI.
   *
   * This is intentionally a small whitelist, not a generic "call any native
   * tool" escape hatch. The payload name is resolved in native-tool-rpc.ts
   * (currently web_search/web_fetch aliases only), and the call must be tied
   * to a live runId so a stray process cannot reuse the socket after cleanup.
   */
  private async handleNativeTool(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}
    if (!reqId) { log.warn({ event: 'native_tool.bus.missing_reqId' }); return }
    if (payload._im_context) delete payload._im_context
    if (!runId) {
      this.sendNativeToolResult(socket, reqId, {
        ok: false,
        error: 'unknown runId: null — native_tool requires a live runContext',
      })
      return
    }
    const ctx: RunContext | null = this.runContexts.get(runId) ?? null
    if (!ctx) {
      this.sendNativeToolResult(socket, reqId, {
        ok: false,
        error: `unknown runId: ${runId} — native_tool requires a live runContext`,
      })
      return
    }

    const { handleNativeToolOp } = await import('./native-tool-rpc.js')
    try {
      const result = await handleNativeToolOp(payload, {
        reqId,
        runContext: ctx,
        requestApproval: ({ toolName, input }) => new Promise((resolve, reject) => {
          const approvalReqId = `${reqId}:native:${randomUUID()}`
          void this.registerSyntheticPending({
            runId,
            reqId: approvalReqId,
            toolName,
            input,
            ctx,
            dispatch: (decision) => resolve(decision),
          }).catch((err) => reject(err))
        }),
      })
      this.sendNativeToolResult(socket, reqId, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.sendNativeToolResult(socket, reqId, { ok: false, error: `native_tool failed: ${msg}` })
    }
  }

  private sendNativeToolResult(
    socket: Socket,
    reqId: string,
    result: import('./native-tool-rpc.js').NativeToolRpcResult,
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

  /**
   * v1.5 — long-term memory ops (memory_query / save / list / delete).
   * Same dispatch pattern as handleReminder / handlePush. Context resolved
   * from runId; inline _im_context fallback supported for single-user MCP.
   */
  private async handleMemory(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const op = typeof m.op === 'string' ? m.op : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}
    if (!reqId) { log.warn({ event: 'memory.bus.missing_reqId' }); return }
    if (!op) {
      this.sendMemoryResult(socket, reqId, { ok: false, error: 'invalid memory message (op missing)' })
      return
    }

    // _im_context fallback is intentionally NOT supported for memory ops.
    // memory_query / memory_save / memory_list / memory_delete are scoped
    // by RunContext.userId; accepting an agent-asserted identity would let
    // any caller read or modify other users' memory when MCP daemons are
    // shared across users (e.g. opencode's single long-lived MCP process).
    // Force runId resolution.
    if (payload._im_context) delete payload._im_context
    const ctx: RunContext | null = runId ? (this.runContexts.get(runId) ?? null) : null
    if (!ctx) {
      this.sendMemoryResult(socket, reqId, {
        ok: false,
        error: `unknown runId: ${runId} — memory ops require a live runContext (no _im_context fallback)`,
      })
      return
    }
    const { handleMemoryOp } = await import('./memory-rpc.js')
    const result = await handleMemoryOp(op, payload, ctx)
    this.sendMemoryResult(socket, reqId, result)
  }

  private sendMemoryResult(
    socket: Socket, reqId: string,
    result: { ok: true; result: unknown } | { ok: false; error: string },
  ): void {
    if (!socket.writable) return
    const wire: Record<string, unknown> = { v: 1, type: 'memory.result', reqId, ok: result.ok }
    if (result.ok) wire.result = result.result
    else wire.error = result.error
    socket.write(`${JSON.stringify(wire)}\n`, (err) => {
      if (err) log.warn({ event: 'memory.bus.write_failed', reqId, err: String(err) })
    })
  }

  /** v1.2.63 — long_task / complete_goal RPC handler. Mirrors handleMemo's
   *  shape exactly; goals.ts state lives per-thread so we tie identity to
   *  the live RunContext (no _im_context fallback — same reasoning as
   *  memory ops). */
  private async handleGoal(m: Record<string, unknown>, socket: Socket): Promise<void> {
    const reqId = typeof m.reqId === 'string' ? m.reqId : null
    const runId = typeof m.runId === 'string' ? m.runId : null
    const op = typeof m.op === 'string' ? m.op : null
    const payload = (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload))
      ? m.payload as Record<string, unknown>
      : {}
    if (!reqId) { log.warn({ event: 'goal.bus.missing_reqId' }); return }
    if (!op || (op !== 'long_task' && op !== 'complete_goal')) {
      this.sendGoalResult(socket, reqId, { ok: false, error: 'invalid goal message (op must be long_task|complete_goal)' })
      return
    }
    const ctx: RunContext | null = runId ? (this.runContexts.get(runId) ?? null) : null
    if (!ctx) {
      this.sendGoalResult(socket, reqId, {
        ok: false,
        error: `unknown runId: ${runId} — goal ops require a live runContext`,
      })
      return
    }
    const { handleGoalOp } = await import('./goal-rpc.js')
    const result = await handleGoalOp(op, payload, {
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
      callerAgent: ctx.callerAgent,
    })
    this.sendGoalResult(socket, reqId, result)
  }

  private sendGoalResult(
    socket: Socket, reqId: string,
    result: { ok: true; result: unknown } | { ok: false; error: string },
  ): void {
    if (!socket.writable) return
    const wire: Record<string, unknown> = { v: 1, type: 'goal.result', reqId, ok: result.ok }
    if (result.ok) wire.result = result.result
    else wire.error = result.error
    socket.write(`${JSON.stringify(wire)}\n`, (err) => {
      if (err) log.warn({ event: 'goal.bus.write_failed', reqId, err: String(err) })
    })
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
    const fingerprint = inputFingerprint(args.toolName, args.input)
    const cKey = threadKey(args.ctx.platform, args.ctx.channelId, args.ctx.threadId)

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
    if (READONLY_TOOLS.has(args.toolName) && this.isReadonlyAutoAllowEnabled(cKey)) {
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

    // AGIM_AUTO_APPROVE — immediate allow without IM card or timeout.
    // Fires after sensitive-path hard-deny (above) and self-protect
    // (inline below). Skips the notifier entirely so we must run
    // self-protect here rather than relying on approval-router.
    if (isAutoApproveEnabled()) {
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
      this.evictOldestPending()
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

  /** v1.3.7 (F8) — deny + drop the oldest unresolved pending approval so the
   *  maps stay under MAX_PENDING_APPROVALS. Insertion order of a Map is
   *  iteration order, and pendingById is inserted in registration order, so
   *  the first unresolved entry is the oldest. */
  private evictOldestPending(): void {
    for (const p of this.pendingById.values()) {
      if (p.resolved) continue
      log.warn({
        event: 'approval.bus.pending_cap_evict',
        reqId: p.reqId, runId: p.runId, toolName: p.toolName,
        pending: this.pendingById.size, cap: MAX_PENDING_APPROVALS,
      }, `pending-approval cap (${MAX_PENDING_APPROVALS}) reached — denying oldest request ${p.reqId}`)
      this.cancelPending(p, { behavior: 'deny', message: 'approval evicted: too many pending approvals' }, 'timeout')
      return
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

function autoAllowRuleKey(toolName: string, fingerprint: string): string {
  return `${toolName}::${fingerprint}`
}

/**
 * Translate a raw fingerprint string (e.g. `cmd:git+status`) into the
 * human-readable form shown in IM receipts and `/approval` listings
 * (e.g. `命令 git status`). The inverse of inputFingerprint()'s internal
 * encoding — keep the scheme list in sync if you add new fingerprint
 * variants.
 *
 * Unknown / legacy schemes pass through unchanged so the function is
 * forward-compatible with future fingerprint additions and backward-
 * compatible with rules created before the semantic split (no scheme).
 */
export function humanizeFingerprint(fingerprint: string): string {
  const sep = fingerprint.indexOf(':')
  if (sep < 0) return fingerprint
  const scheme = fingerprint.slice(0, sep)
  const rest = fingerprint.slice(sep + 1)
  switch (scheme) {
    case 'cmd':   return `命令 ${rest.replace(/\+/g, ' ')}`
    case 'dir':   return `目录 ${rest}`
    case 'host':  return `主机 ${rest}`
    case 'path':  return `路径 ${rest}`
    case 'pat':   return `模式 ${rest}`
    case 'query': return `查询 ${rest}`
    case 'url':   return `URL ${rest}`
    case 'raw':   return `入参 ${rest}`
    default:      return fingerprint
  }
}

/**
 * Compute the auto-allow fingerprint — the "kind" of call that, when
 * approved with `all`, covers future similar calls.
 *
 * Semantic per tool (rather than a uniform prefix slice) — fixes two
 * footguns of the old prefix-based approach:
 *   1. `Bash git status` and `git stash` collided at 5 chars but split at
 *      10 — neither setting matched user intuition. We extract the first
 *      two tokens (`cmd:git+status` vs `cmd:git+stash`) so the family is
 *      narrow and predictable.
 *   2. `Read /tmp/a.txt` and `Read /tmp/b.txt` got distinct fingerprints
 *      at any prefix length below the filename, forcing users to re-`all`
 *      every file. We key on dirname (`dir:/tmp`) so one approval covers
 *      the whole directory.
 *
 * Prefixes (`cmd:` / `dir:` / `host:` / `path:` / `pat:` / `query:` /
 * `url:` / `raw:`) keep the key space disambiguated — rules from
 * different schemes can never accidentally alias each other, and `raw:`
 * preserves backward compatibility for unknown tools.
 *
 * EXPORTED for unit tests. Not part of the bus's public API; production
 * call sites all live inside this module.
 */
export function inputFingerprint(toolName: string, input: Record<string, unknown>): string {
  const getStr = (k: string): string | null => {
    const v = input[k]
    return typeof v === 'string' && v.length > 0 ? v : null
  }

  switch (toolName) {
    case 'Bash': {
      const cmd = getStr('command')
      if (!cmd) break
      // First 1–2 whitespace-separated tokens. Quoted strings aren't
      // unwrapped — we want `bash -c "..."` to fingerprint as `bash+-c`,
      // not whatever's inside the quotes (the user is approving "running
      // bash -c", a meta-pattern).
      const tokens = cmd.trim().split(/\s+/).slice(0, 2)
      return `cmd:${tokens.join('+')}`
    }

    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
    case 'NotebookRead': case 'LS': {
      const fp = getStr('file_path') ?? getStr('path')
      if (!fp) break
      // dirname('/tmp/x.txt') → '/tmp'  (group all files in dir)
      // dirname('file.txt')   → '.'     (no dir — fall back to the path
      //                                  itself so we don't lump every
      //                                  relative-path call together)
      const d = dirname(fp)
      return d === '.' || d === '' ? `path:${fp.slice(0, AUTO_ALLOW_PREFIX_LEN)}` : `dir:${d}`
    }

    case 'WebFetch': {
      const u = getStr('url')
      if (!u) break
      // Hostname captures "calls to this API"; path / query string are
      // intentionally dropped — they vary per call but the user means
      // "trust this host" when they say `all`.
      try { return `host:${new URL(u).hostname}` }
      catch { return `url:${u.slice(0, AUTO_ALLOW_PREFIX_LEN)}` }
    }

    case 'WebSearch': {
      const q = getStr('query')
      if (!q) break
      return `query:${q.slice(0, AUTO_ALLOW_PREFIX_LEN)}`
    }

    case 'Glob': case 'Grep': {
      const p = getStr('pattern')
      if (!p) break
      return `pat:${p.slice(0, AUTO_ALLOW_PREFIX_LEN)}`
    }
  }

  // Unknown tool or known tool whose primary field was missing — fall
  // back to a stringified prefix so the dedup key remains stable.
  let s: string
  try { s = JSON.stringify(input) } catch { s = '' }
  return `raw:${s.slice(0, AUTO_ALLOW_PREFIX_LEN)}`
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
