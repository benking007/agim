/**
 * chat-ws-handlers.ts — WebSocket message normalization and dispatch for chat.
 *
 * Contains:
 *   - normalizeActivityStep  — converts the raw WS step shape to ChatActivityStep
 *   - normalizeHistoryMessage — converts a HistoryMessage wire frame to ChatMessage
 *   - toastForOutcome        — fires a sonner toast for an approval outcome
 *   - makeOnIncoming         — factory that closes over dispatch + streaming refs
 *                              and returns the onIncoming handler used in useChat
 *
 * All pure helpers are exported for direct unit testing. makeOnIncoming is the
 * only function that carries side effects (dispatch, toast, setTimeout).
 */

import { toast } from 'sonner'
import i18n from '@/i18n'
import { adoptThreadId, sessionTitleFromText, upsertSession } from '@/lib/web-sessions'
import type { ActivityStepEvent, ChatIncoming, HistoryMessage, ApprovalCardOutcome } from '@/types/ws'
import { isHistoryComplete, historyBelongsToClient, type ChatAction } from './chat-reducer'
import { APPROVAL_DISMISS_AFTER_MS } from './chat-types'
import type { ChatActivityStep, ChatMessage } from './chat-types'

export interface OnIncomingOptions {
  /** Live thread id — updated on switch / new / thread-reassigned. */
  threadIdRef?: { current: string }
}

/** Frames that belong to one `web-*` session. Foreign threadId is dropped
 *  so an in-flight run on A cannot paint into B after a switch. */
const SESSION_SCOPED_FRAMES = new Set<ChatIncoming['type']>([
  'history',
  'history-prepend',
  'active-run',
  'chunk',
  'done',
  'run-start',
  'run-finish',
  'usage',
  'activity-step',
  'agent-switched',
  'plan-mode',
  'step-reflect-mode',
  'think-mode',
  'session-model',
  'compact-rate',
  'error',
  'approval-text',
  'approval-card',
  'approval-card-edit',
  'choice-card',
  'choice-card-edit',
  'subagent-stopped',
  'loop-changed',
  'loop-schedule-changed',
  'steer-accepted',
])

function incomingThreadId(msg: ChatIncoming): string | undefined {
  return 'threadId' in msg && typeof msg.threadId === 'string' ? msg.threadId : undefined
}

// ---------------------------------------------------------------------------
// Pure normalizers
// ---------------------------------------------------------------------------

/** Normalize a raw WS step (number|string timestamps) to ChatActivityStep. */
export function normalizeActivityStep(st: ActivityStepEvent['step']): ChatActivityStep {
  const startedAt = typeof st.startedAt === 'number'
    ? st.startedAt
    : (Number.isFinite(Date.parse(String(st.startedAt)))
        ? Date.parse(String(st.startedAt))
        : Date.now())
  const finishedAt = st.finishedAt == null
    ? undefined
    : typeof st.finishedAt === 'number'
      ? st.finishedAt
      : (Number.isFinite(Date.parse(String(st.finishedAt)))
          ? Date.parse(String(st.finishedAt))
          : undefined)
  return {
    id: st.id,
    kind: st.kind === 'skill' || st.kind === 'status'
      || st.kind === 'approval' || st.kind === 'ask'
      || st.kind === 'agent' || st.kind === 'reflect'
      ? st.kind
      : 'tool',
    label: st.label,
    status: st.status,
    startedAt,
    finishedAt,
    preview: st.preview,
    ...(st.todoItems ? { todoItems: st.todoItems } : {}),
    ...(typeof st.jobId === 'number' ? { jobId: st.jobId } : {}),
    ...(st.reflects?.length ? { reflects: st.reflects } : {}),
    ...(st.lastTool ? { lastTool: st.lastTool } : {}),
  }
}

/** Normalize a HistoryMessage wire frame to a ChatMessage. */
export function normalizeHistoryMessage(h: HistoryMessage, i: number): ChatMessage {
  const activity = h.activity
    ? {
        runId: h.activity.runId,
        status: h.activity.status,
        startedAt: h.activity.startedAt,
        finishedAt: h.activity.finishedAt,
        durationMs: h.activity.durationMs,
        error: h.activity.error,
        steps: h.activity.steps.map(normalizeActivityStep),
      }
    : undefined
  return {
    id: h.id || `hist-${typeof h.serverIndex === 'number' ? h.serverIndex : i}`,
    role: h.role,
    content: h.content,
    agent: h.agent,
    timestamp: h.timestamp ? Date.parse(h.timestamp) : Date.now() - i * 1000,
    activity,
    serverIndex: typeof h.serverIndex === 'number' ? h.serverIndex : i,
    ...(h.feedback === 'up' || h.feedback === 'down' ? { feedback: h.feedback } : {}),
  }
}

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------

/** Surface a one-line resolution outcome via sonner. */
export function toastForOutcome(o: ApprovalCardOutcome): void {
  const tr = (key: string, fallback: string): string => i18n.t(`chat.outcome.${key}`, {
    ns: 'common',
    defaultValue: fallback,
  })
  switch (o.decision) {
    case 'allowed':
      toast.success(tr('allowed', 'Allowed'))
      return
    case 'allowed-pinned':
      toast.success(tr('allowedPinned', 'Allowed + auto-allow further'))
      return
    case 'denied':
      toast.error(tr('denied', 'Denied'))
      return
    case 'denied-revoked':
      toast.error(tr('deniedRevoked', 'Denied (auto-allow revoked)'))
      return
    case 'expired':
      toast.warning(tr('expired', 'Timed out'))
      return
  }
}

// ---------------------------------------------------------------------------
// onIncoming factory
// ---------------------------------------------------------------------------

/**
 * Returns the onIncoming message handler bound to the hook's mutable refs.
 * Kept as a factory (vs. a hook itself) so it stays out of the React tree
 * and can be constructed once inside useEffect without stale closures.
 */
export function makeOnIncoming(
  dispatch: (action: ChatAction) => void,
  currentReplyIdRef: { current: string | null },
  bufferChunk: (text: string) => void,
  flushChunks: () => void,
  opts?: OnIncomingOptions,
): (msg: ChatIncoming) => void {
  return function onIncoming(msg: ChatIncoming): void {
    if (
      SESSION_SCOPED_FRAMES.has(msg.type)
      && !historyBelongsToClient(incomingThreadId(msg), opts?.threadIdRef?.current)
    ) return
    switch (msg.type) {
      case 'init':
        dispatch({
          kind: 'INIT',
          agents: msg.agents,
          defaultAgent: msg.defaultAgent,
          clientId: msg.clientId,
        })
        return
      case 'history': {
        const current = opts?.threadIdRef?.current
        const messages = msg.messages.map(normalizeHistoryMessage)
        const complete = isHistoryComplete(msg)
        dispatch({
          kind: 'HISTORY',
          agent: msg.agent,
          preferredWorkerAgent: msg.preferredWorkerAgent || '',
          planMode: msg.planMode,
          stepReflect: msg.stepReflect,
          stepReflectDisabled: msg.stepReflectDisabled,
          thinkVariant: msg.thinkVariant,
          sessionModel: msg.sessionModel,
          compactRate: msg.compactRate,
          historyComplete: complete,
          olderCount: msg.olderCount ?? 0,
          updatedAt: typeof msg.updatedAt === 'number' ? msg.updatedAt : undefined,
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
          messages,
        })
        const threadId = msg.threadId || current
        if (threadId) {
          const titleSource = (msg.sessionTitle || '').trim()
            || (complete
              ? (messages.find((m) => m.role === 'user' && m.content.trim())?.content ?? '')
              : '')
          upsertSession({
            id: threadId,
            agent: msg.agent,
            ...(typeof msg.updatedAt === 'number' && Number.isFinite(msg.updatedAt)
              ? { updatedAt: msg.updatedAt }
              : {}),
            ...(titleSource ? { title: sessionTitleFromText(titleSource) } : {}),
          })
        }
        return
      }
      case 'history-prepend': {
        const current = opts?.threadIdRef?.current
        const messages = msg.messages.map(normalizeHistoryMessage)
        dispatch({
          kind: 'HISTORY_PREPEND',
          messages,
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
        })
        const threadId = msg.threadId || current
        if (threadId && (msg.remaining ?? 0) === 0) {
          const firstUser = messages.find((m) => m.role === 'user' && m.content.trim())
          if (firstUser) {
            upsertSession({
              id: threadId,
              title: sessionTitleFromText(firstUser.content),
            })
          }
        }
        return
      }
      case 'plan-mode':
        dispatch({ kind: 'PLAN_MODE', enabled: !!msg.enabled })
        return
      case 'step-reflect-mode':
        dispatch({
          kind: 'STEP_REFLECT_MODE',
          enabled: !!msg.enabled,
          disabled: msg.disabled,
        })
        return
      case 'think-mode':
        dispatch({ kind: 'THINK_MODE', variant: msg.variant || 'auto' })
        return
      case 'session-model':
        dispatch({ kind: 'SESSION_MODEL', model: msg.model || '' })
        return
      case 'compact-rate':
        dispatch({ kind: 'COMPACT_RATE', rate: msg.rate || 'auto' })
        return
      case 'active-run':
        dispatch({
          kind: 'ACTIVE_RUN',
          runId: msg.runId,
          agent: msg.agent,
          startedAt: Number.isFinite(Date.parse(msg.startedAt))
            ? Date.parse(msg.startedAt)
            : Date.now(),
          status: msg.status,
          steps: msg.steps.map(normalizeActivityStep),
          partialText: msg.partialText || '',
          finishedAt: msg.finishedAt && Number.isFinite(Date.parse(msg.finishedAt))
            ? Date.parse(msg.finishedAt)
            : undefined,
          durationMs: msg.durationMs,
          error: msg.error,
          ...(msg.threadId ? { threadId: msg.threadId } : {}),
        })
        // Eagerly bind the streaming target so chunks that arrive before
        // the React effect syncing currentReplyIdRef are not dropped.
        currentReplyIdRef.current = msg.status === 'running'
          ? `reply-restore-${msg.runId}`
          : null
        return
      case 'agents':
        dispatch({ kind: 'AGENTS', agents: msg.agents })
        return
      case 'agent-switched':
        dispatch({
          kind: 'AGENT_SWITCHED',
          agent: msg.agent,
          preferredWorkerAgent: msg.preferredWorkerAgent || '',
        })
        return
      case 'run-start':
        dispatch({
          kind: 'RUN_START',
          runId: msg.runId,
          agent: msg.agent,
          startedAt: Number.isFinite(Date.parse(msg.startedAt))
            ? Date.parse(msg.startedAt)
            : Date.now(),
        })
        return
      case 'usage':
        dispatch({
          kind: 'RUN_USAGE',
          runId: msg.runId,
          durationMs: msg.durationMs,
          outputChars: msg.outputChars,
        })
        return
      case 'run-finish':
        dispatch({
          kind: 'RUN_FINISH',
          runId: msg.runId,
          status: msg.status,
          finishedAt: Number.isFinite(Date.parse(msg.finishedAt))
            ? Date.parse(msg.finishedAt)
            : Date.now(),
          durationMs: msg.durationMs,
          error: msg.error,
        })
        return
      case 'activity-step': {
        dispatch({
          kind: 'ACTIVITY_STEP',
          runId: msg.runId,
          step: normalizeActivityStep(msg.step),
        })
        return
      }
      case 'chunk':
        bufferChunk(msg.text)
        return
      case 'done':
        flushChunks()
        dispatch({
          kind: 'DONE',
          // Same stale-closure trap as bufferChunk — read via ref.
          replyId: currentReplyIdRef.current ?? '',
          finalText: msg.text,
          runId: msg.runId,
          messageId: msg.messageId,
        })
        return
      case 'error':
        flushChunks()
        dispatch({ kind: 'ERROR', message: msg.message })
        return
      case 'thread-reassigned': {
        // Foreign localStorage threadId — adopt the server-minted session
        // (already owned by this token) instead of hard-erroring.
        const next = typeof msg.threadId === 'string' ? msg.threadId.trim() : ''
        if (next && /^web-[A-Za-z0-9_-]{4,64}$/.test(next)) {
          adoptThreadId(next, opts?.threadIdRef?.current)
          if (opts?.threadIdRef) opts.threadIdRef.current = next
          dispatch({ kind: 'SET_CLIENT_ID', clientId: next })
        }
        if (msg.reason === 'ownership_mismatch') {
          toast.message(i18n.t('chat.threadReassigned', {
            ns: 'common',
            defaultValue: 'Previous chat belongs to another login — started a new conversation.',
          }))
        }
        return
      }
      case 'approval-card':
        dispatch({
          kind: 'APPROVAL_CARD',
          messageId: msg.messageId,
          prompt: msg.prompt,
        })
        return
      case 'approval-card-edit':
        dispatch({
          kind: 'APPROVAL_EDIT',
          messageId: msg.messageId,
          outcome: msg.outcome,
        })
        // v1.2.115 — toast on resolve so the dismissal isn't silent.
        // The dock row itself flips to a ✅/❌ badge for ~1.2s before
        // fading out (driven by APPROVAL_DISMISS_AFTER_MS); the toast
        // carries the outcome label so it stays visible after the row vanishes.
        toastForOutcome(msg.outcome)
        window.setTimeout(() => {
          dispatch({ kind: 'APPROVAL_DISMISS', messageId: msg.messageId })
        }, APPROVAL_DISMISS_AFTER_MS)
        return
      case 'choice-card':
        dispatch({
          kind: 'CHOICE_CARD',
          messageId: msg.messageId,
          prompt: msg.prompt,
        })
        return
      case 'choice-card-edit':
        // The ask resolved (answer accepted, or timed out). Flip the dock
        // row to its receipt for a beat, then dismiss — same cadence as
        // approval cards.
        dispatch({
          kind: 'CHOICE_EDIT',
          messageId: msg.messageId,
          finalText: msg.finalText,
        })
        window.setTimeout(() => {
          dispatch({ kind: 'CHOICE_DISMISS', messageId: msg.messageId })
        }, APPROVAL_DISMISS_AFTER_MS)
        return
      case 'approval-text':
        // approval-text is the legacy fallback path used by adapters
        // that can't render cards (or for "receipt" lines after a
        // card resolves). v1.2.115: surface as a toast — no longer
        // injected into the chat stream — and ignore the dispatch.
        toast.info(msg.text)
        return
      case 'metrics':
        // Dashboards (PR-N) consume these; the chat surface ignores.
        return
      case 'loop-changed':
        // Portal Loop docks subscribe via openChatWs in use-portal-loop.
        return
      case 'loop-schedule-changed':
        return
      case 'steer-accepted':
        // Optimistic APPEND_USER already painted the bubble.
        return
      default:
        return
    }
  }
}
