// goal-rpc — thin RPC wrapper around goals.ts for MCP tool exposure
// (v1.2.63). Used by both the agim-dispatcher (native) and the
// claude-code MCP sidecar so every agent can self-register a sustained
// objective via `mcp__agim__long_task` / `mcp__agim__complete_goal`.
//
// Two operations:
//   - 'long_task'    { goal, summary? }  → setActiveGoal({title:goal, body:summary})
//                                          + initial progress note
//   - 'complete_goal' { goalId, goalVersion, evidenceIds?, recap, status? }
//       → transactional CAS close; native completions require current evidence
//
// Both require a RunContext (platform / channelId / threadId / userId).
// The RPC is intentionally narrow — it does NOT support listing,
// pausing, or editing goals; those live in the `/goal` slash command
// surface (commands/goal.ts). The MCP tools are the model's first-
// person path: "register this goal" / "this goal is done".

import {
  setActiveGoal,
  getActiveGoal,
  getGoalByIdState,
  appendProgress,
  type GoalRow,
} from './goals.js'
import { completeGoalCas, getGoalEvidenceReview } from './goal-evidence.js'
import { evaluateTodoCompletionGate } from './llm/todo-dispatcher.js'
import { runGoalCompletionCritic } from './llm/goal-critic.js'
import type { CompletionCriticInput, CompletionCriticVerdict } from './llm/goal-critic.js'
import { eventBus } from './event-bus.js'
import { logger as rootLogger } from './logger.js'
import { approvalBus } from './approval-bus.js'
import { randomUUID } from 'node:crypto'

/** How long complete_goal waits for the owner's explicit yes/no.
 *  Independent of the default 60s tool wall clock — confirmation is a
 *  human round-trip and must outlive AGIM_NATIVE_TOOL_TIMEOUT_MS. */
export function resolveGoalConfirmationTimeoutMs(): number {
  const raw = (process.env.AGIM_GOAL_CONFIRMATION_TIMEOUT_MS ?? '').trim()
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return approvalBus.approvalTimeoutMs
}

/** Tool-bridge wall budget for mcp__agim__complete_goal: confirmation
 *  timeout plus a small settle margin so the approval deny path can
 *  return before the tool race aborts. */
export function resolveCompleteGoalToolTimeoutMs(): number {
  return resolveGoalConfirmationTimeoutMs() + 60_000
}

function emitGoalEvent(
  phase: 'created' | 'status' | 'progress',
  row: { id: number; platform: string; channelId: string; threadId: string; status?: string; title?: string },
  summary?: string,
): void {
  try {
    eventBus.publish({
      type: 'goal',
      phase,
      goalId: row.id,
      platform: row.platform,
      channelId: row.channelId,
      threadId: row.threadId,
      status: row.status as 'active' | 'paused' | 'completed' | 'cancelled' | undefined,
      summary: (summary ?? row.title ?? '').slice(0, 120),
      ts: new Date().toISOString(),
    })
  } catch { /* best-effort */ }
}

const log = rootLogger.child({ component: 'goal-rpc' })

/** Backward-compatible test seam; idempotency is now persisted in goals.db. */
export function __resetCompletionCacheForTesting(): void {
  // no-op
}

export interface GoalRpcCtx {
  platform: string
  channelId: string
  threadId: string
  userId: string
  /** Optional — included in the audit log + progress note attribution
   *  so we can tell native-set goals from sidecar-set ones. */
  callerAgent?: string
  traceId?: string
  /** Optional workspace scope hash (cwd) stamped onto new goals. */
  workspaceScope?: string
  /** Tests can bypass the external semantic model while exercising CAS. */
  skipSemanticReview?: boolean
  /** Test seam for deterministic semantic verdicts. Never populated from RPC payloads. */
  reviewGoalCompletion?: (input: CompletionCriticInput) => Promise<CompletionCriticVerdict>
  skipUserConfirmation?: boolean
  confirmGoalCompletion?: (input: {
    goalId: number
    goalVersion: number
    recap: string
  }) => Promise<boolean>
  signal?: AbortSignal
}

export type GoalOp = 'long_task' | 'complete_goal'

export interface LongTaskPayload {
  goal?: unknown
  summary?: unknown
  /** v1.3.7 (F7) — must be true to override (auto-pause) an existing
   *  active goal. Without it, long_task refuses when a goal is already
   *  active so the model makes an explicit choice rather than silently
   *  burying the prior objective. */
  force?: unknown
}

export interface CompleteGoalPayload {
  goalId?: unknown
  goalVersion?: unknown
  evidenceIds?: unknown
  recap?: unknown
  status?: unknown
}

export type GoalRpcResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string }

export async function handleGoalOp(op: GoalOp, payload: unknown, ctx: GoalRpcCtx): Promise<GoalRpcResult> {
  if (!ctx.platform || !ctx.threadId || !ctx.userId) {
    return { ok: false, error: 'goal RPC requires platform + threadId + userId' }
  }
  if (op === 'long_task') return handleLongTask(payload as LongTaskPayload, ctx)
  if (op === 'complete_goal') return handleCompleteGoal(payload as CompleteGoalPayload, ctx)
  return { ok: false, error: `unknown goal op: ${String(op)}` }
}

function handleLongTask(p: LongTaskPayload, ctx: GoalRpcCtx): GoalRpcResult {
  const goal = typeof p.goal === 'string' ? p.goal.trim() : ''
  if (!goal) return { ok: false, error: 'long_task requires a non-empty `goal` string (one-line objective).' }
  const summary = typeof p.summary === 'string' ? p.summary : undefined
  const force = p.force === true

  // v1.3.7 (F7) — refuse to silently bury an existing active goal.
  // setActiveGoal() auto-pauses any current 'active' row, so without this
  // guard a stray long_task call would pause the user's real objective
  // with no confirmation. Require an explicit force:true (or complete the
  // prior goal first).
  const prior = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
  if (prior && !force) {
    return {
      ok: false,
      error: `an active goal already exists on this thread: #${prior.id} "${prior.title}". ` +
        'Call complete_goal first if it is done, or retry long_task with force:true to ' +
        'pause it and start the new objective.',
    }
  }

  const row = setActiveGoal({
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    userId: ctx.userId,
    title: goal,
    body: summary,
    replaceActive: force,
    evidenceRequired: ctx.callerAgent === 'native',
    workspaceScope: ctx.workspaceScope,
  })
  if (!row) {
    return { ok: false, error: 'failed to register goal (db unavailable or empty title)' }
  }

  appendProgress(row.id, 'agent', `objective registered by ${ctx.callerAgent ?? 'agent'}`)
  const current = getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId) ?? row
  // v1.2.86 — emit so /tasks/goals web view + any SSE consumer
  // updates without polling.
  emitGoalEvent('created', {
    id: row.id, platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.threadId,
    status: row.status, title: row.title,
  })
  if (prior) {
    emitGoalEvent('status', {
      id: prior.id, platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.threadId,
      status: 'paused', title: prior.title,
    }, 'auto-paused by new goal')
  }
  log.info({
    event: 'goal-rpc.long_task',
    callerAgent: ctx.callerAgent ?? 'unknown',
    threadId: ctx.threadId,
    goalId: row.id,
    prior_id: prior?.id ?? null,
    prior_paused: prior !== null,
  }, `registered long_task #${row.id}${prior ? ` (paused previous #${prior.id})` : ''}`)

  return {
    ok: true,
    result: {
      goalId: current.id,
      goalVersion: current.version,
      mutationEpoch: current.mutationEpoch,
      evidenceRequired: current.evidenceRequired,
      title: current.title,
      status: current.status,
      previous_active_goal_paused: prior ? { id: prior.id, title: prior.title } : null,
      hint: 'I will see this goal in the [Active goal] block on every turn until completed. ' +
        'Call complete_goal with this exact goalId/goalVersion and current evidence IDs when done.',
    },
  }
}

async function confirmGoalCompletion(
  ctx: GoalRpcCtx,
  input: { goalId: number; goalVersion: number; recap: string },
): Promise<boolean> {
  if (ctx.skipUserConfirmation) return true
  if (ctx.confirmGoalCompletion) return await ctx.confirmGoalCompletion(input)
  if (!approvalBus.hasNotifier() || !ctx.platform || !ctx.threadId) return false
  if (ctx.signal?.aborted) return false
  const reqId = randomUUID()
  const runId = ctx.traceId || `goal-completion-${input.goalId}`
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false
    const cleanup = () => ctx.signal?.removeEventListener('abort', onAbort)
    const finish = (allowed: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(allowed)
    }
    const onAbort = () => {
      approvalBus.cancelPendingByReqId(reqId, 'goal completion cancelled: turn aborted')
      finish(false)
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    void approvalBus.registerSyntheticPending({
      runId,
      reqId,
      toolName: 'mcp__agim__complete_goal',
      input: {
        goalId: input.goalId,
        goalVersion: input.goalVersion,
        recap: input.recap,
      },
      requiresExplicitDecision: true,
      timeoutMs: resolveGoalConfirmationTimeoutMs(),
      ctx: {
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId,
        callerAgent: ctx.callerAgent,
        traceId: ctx.traceId,
      },
      dispatch: (decision) => finish(decision.behavior === 'allow'),
    }).then(() => {
      if (ctx.signal?.aborted) onAbort()
    }).catch((err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })
  })
}

async function handleCompleteGoal(p: CompleteGoalPayload, ctx: GoalRpcCtx): Promise<GoalRpcResult> {
  const goalId = typeof p.goalId === 'number' ? p.goalId : Number.NaN
  const goalVersion = typeof p.goalVersion === 'number' ? p.goalVersion : Number.NaN
  if (!Number.isSafeInteger(goalId) || goalId <= 0 || !Number.isSafeInteger(goalVersion) || goalVersion <= 0) {
    return {
      ok: false,
      error: 'complete_goal requires the exact positive integer `goalId` and `goalVersion` from the active-goal Completion token.',
    }
  }
  const recap = typeof p.recap === 'string' ? p.recap.trim() : ''
  const requestedStatus = typeof p.status === 'string' ? p.status : 'completed'
  if (requestedStatus !== 'completed' && requestedStatus !== 'cancelled') {
    return { ok: false, error: 'complete_goal status must be completed or cancelled' }
  }
  const status: 'completed' | 'cancelled' = requestedStatus === 'cancelled' ? 'cancelled' : 'completed'
  if (recap.length < 10) {
    return {
      ok: false,
      error: 'complete_goal requires a `recap` string ≥ 10 characters. ' +
        'Write what was actually accomplished (or, if status=cancelled, ' +
        'why). Examples: "found 3 candidates, picked X, deployed to staging" ' +
        '/ "user changed direction to Y, abandoning original plan".',
    }
  }
  const evidenceIds = Array.isArray(p.evidenceIds)
    ? p.evidenceIds.filter((value): value is string => typeof value === 'string').slice(0, 16)
    : []
  if (status === 'completed' && ctx.callerAgent === 'native') {
    const todoGate = evaluateTodoCompletionGate(
      `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`,
    )
    if (!todoGate.ok) return todoGate
  }
  const tokenGoalState = getGoalByIdState(goalId)
  if (!tokenGoalState.available) {
    return { ok: false, error: 'goal database unavailable; completion blocked' }
  }
  const tokenGoal = tokenGoalState.goal
  const tokenIsCurrent = !!tokenGoal
    && tokenGoal.platform === ctx.platform
    && tokenGoal.channelId === ctx.channelId
    && tokenGoal.threadId === ctx.threadId
    && tokenGoal.userId === ctx.userId
    && tokenGoal.status === 'active'
    && tokenGoal.version === goalVersion
  if (
    status === 'completed'
    && tokenIsCurrent
    && tokenGoal?.evidenceRequired
    && !ctx.skipSemanticReview
  ) {
    const review = getGoalEvidenceReview({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      userId: ctx.userId,
      goalId,
      goalVersion,
      evidenceIds,
      traceId: ctx.traceId,
    })
    if (!review) {
      return { ok: false, error: 'SEMANTIC_REVIEW_UNAVAILABLE: evidence could not be prepared' }
    }
    const criticInput: CompletionCriticInput = {
      goalTitle: review.goalTitle,
      goalBody: review.goalBody,
      evidence: review.recentToolCalls.map((item) => ({
        name: item.name,
        preview: item.preview,
      })),
    }
    const verdict = ctx.reviewGoalCompletion
      ? await ctx.reviewGoalCompletion(criticInput)
      : await runGoalCompletionCritic(criticInput)
    if (!ctx.reviewGoalCompletion && !verdict.modelUsed) {
      return { ok: false, error: `SEMANTIC_REVIEW_UNAVAILABLE: ${verdict.reason}` }
    }
    if (!verdict.completed) {
      return {
        ok: false,
        error: `GOAL_INCOMPLETE: ${verdict.reason}`,
      }
    }
  }
  if (
    status === 'completed'
    && tokenIsCurrent
    && tokenGoal?.evidenceRequired
    && !await confirmGoalCompletion(ctx, { goalId, goalVersion, recap })
  ) {
    return {
      ok: false,
      error: approvalBus.hasNotifier()
        ? 'GOAL_CONFIRMATION_DENIED: user did not approve completion'
        : 'USER_CONFIRMATION_REQUIRED: ask the user to run /goal complete',
    }
  }
  const completed = completeGoalCas({
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    userId: ctx.userId,
    goalId,
    goalVersion,
    evidenceIds,
    recap,
    status,
    traceId: ctx.traceId,
  })
  if (!completed.ok) return completed
  if (!completed.alreadyCompleted) {
    emitGoalEvent('status', {
      id: goalId,
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      status,
      title: completed.title,
    }, recap.slice(0, 120))
  }
  log.info({
    event: 'goal-rpc.complete_goal',
    callerAgent: ctx.callerAgent ?? 'unknown',
    threadId: ctx.threadId,
    goalId,
    goalVersion,
    completedVersion: completed.version,
    alreadyCompleted: completed.alreadyCompleted,
    status,
    recapLen: recap.length,
  }, `marked goal #${goalId} ${status}`)

  return {
    ok: true,
    result: {
      goalId,
      goalVersion: completed.version,
      mutationEpoch: completed.mutationEpoch,
      title: completed.title,
      status,
      recap_length: recap.length,
      already_completed: completed.alreadyCompleted,
    },
  }
}

/** Exposed so tests + ad-hoc inspectors can prune state. Not used in
 *  production code paths. */
export function _activeGoalSnapshot(ctx: GoalRpcCtx): GoalRow | null {
  return getActiveGoal(ctx.platform, ctx.channelId, ctx.threadId)
}
