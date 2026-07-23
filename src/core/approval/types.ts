import type { AgentSendOpts } from '../types.js'

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
  /** Root invocation trace used to bind goal evidence lineage. */
  traceId?: string
  /** Web chat activity accordion — forwarded into handleA2A → callAgentByName
   *  so CLI agents (claude-code etc.) can surface "Waiting for subagent". */
  onToolActivity?: AgentSendOpts['onToolActivity']
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
  /** Security-sensitive state transitions (for example exiting Plan Mode)
   * require a one-time human decision. Auto-approve, remembered allow rules,
   * allow-on-timeout, and "allow all" must not bypass this prompt — unless
   * `allowSessionPin` is also set (see below). */
  requiresExplicitDecision?: boolean
  /** When paired with `requiresExplicitDecision`, still bypass global
   *  auto-approve / allow-on-timeout, but let the operator click
   *  "Auto for similar" to seed a per-thread remembered rule (and honor
   *  that rule on later matching requests via the grace path). */
  allowSessionPin?: boolean
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

export interface ApprovalBusOptions {
  approvalTimeoutMs?: number
  /** Window between sending the auto-allow notice and auto-resolving as
   *  allow (when the user doesn't actively deny in the meantime). */
  autoAllowGraceMs?: number
}

/** Composite key that prevents cross-platform/channel thread collisions. */
export function threadKey(platform: string, channelId: string, threadId: string): string {
  return `${platform}:${channelId}:${threadId}`
}
