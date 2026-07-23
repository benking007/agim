/**
 * chat-reducer.ts — pure state machine for the chat route.
 *
 * Holds the action union, initial state, all pure helper functions,
 * and the chatReducer itself. No React imports; no side effects.
 * Extracted from use-chat.ts so that unit tests can import the reducer
 * directly and the hook stays thin.
 */

import type { ApprovalCardOutcome, ApprovalCardPrompt, ChoiceCardPrompt } from '@/types/ws'
import type {
  ChatActivity,
  ChatActivityStep,
  ChatMessage,
  ChatState,
  RunActivity,
} from './chat-types'

// ---------------------------------------------------------------------------
// Action union
// ---------------------------------------------------------------------------

export type ChatAction =
  | { kind: 'WS_STATUS'; status: ChatState['status'] }
  | { kind: 'INIT'; agents: string[]; defaultAgent: string; clientId?: string }
  | { kind: 'SET_CLIENT_ID'; clientId: string }
  | {
      kind: 'HISTORY'
      messages: ChatMessage[]
      agent: string
      planMode?: boolean
      thinkVariant?: string
      sessionModel?: string
      compactRate?: string
    }
  | { kind: 'PLAN_MODE'; enabled: boolean }
  | { kind: 'THINK_MODE'; variant: string }
  | { kind: 'SESSION_MODEL'; model: string }
  | { kind: 'COMPACT_RATE'; rate: string }
  | {
      kind: 'ACTIVE_RUN'
      runId: string
      agent: string
      startedAt: number
      status: 'running' | 'success' | 'error'
      steps: ChatActivityStep[]
      partialText: string
      finishedAt?: number
      durationMs?: number
      error?: string
    }
  | { kind: 'AGENTS'; agents: string[] }
  | { kind: 'AGENT_SWITCHED'; agent: string }
  | { kind: 'SEND_USER'; message: ChatMessage; placeholder: ChatMessage }
  | { kind: 'CHUNK'; replyId: string; text: string }
  | { kind: 'DONE'; replyId: string; finalText: string; runId?: string; messageId?: string }
  | { kind: 'ERROR'; message: string }
  | { kind: 'APPROVAL_CARD'; messageId: string; prompt: ApprovalCardPrompt }
  | { kind: 'APPROVAL_TEXT'; messageId: string; text: string }
  | { kind: 'APPROVAL_EDIT'; messageId: string; outcome: ApprovalCardOutcome }
  | { kind: 'APPROVAL_DISMISS'; messageId: string }
  | { kind: 'CHOICE_CARD'; messageId: string; prompt: ChoiceCardPrompt }
  | { kind: 'CHOICE_EDIT'; messageId: string; finalText: string }
  | { kind: 'CHOICE_DISMISS'; messageId: string }
  | { kind: 'RUN_START'; runId: string; agent: string; startedAt: number }
  | { kind: 'RUN_USAGE'; runId: string; durationMs: number; outputChars: number }
  | {
      kind: 'RUN_FINISH'
      runId: string
      status: 'success' | 'error'
      finishedAt: number
      durationMs: number
      error?: string
    }
  | { kind: 'ACTIVITY_STEP'; runId: string; step: ChatActivityStep }
  | { kind: 'RESET_CONVERSATION' }
  | { kind: 'CLEAR_ERROR' }

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const MAX_RUN_ACTIVITIES = 24

export const initialChatState: ChatState = {
  messages: [],
  pendingApprovals: [],
  pendingAsks: [],
  runActivities: [],
  activeRunId: null,
  agents: [],
  agent: '',
  status: 'connecting',
  currentReplyId: null,
  error: null,
  planMode: false,
  thinkVariant: 'auto',
  sessionModel: '',
  compactRate: 'auto',
  clientId: null,
}

// ---------------------------------------------------------------------------
// Pure helper functions (module-private)
// ---------------------------------------------------------------------------

function findActivityMessageIndex(messages: ChatMessage[], opts: {
  replyId?: string | null
  runId?: string | null
}): number {
  if (opts.runId) {
    const byRun = messages.findIndex((m) => m.activity?.runId === opts.runId)
    if (byRun >= 0) return byRun
  }
  if (opts.replyId) {
    const byReply = messages.findIndex((m) => m.id === opts.replyId)
    if (byReply >= 0) return byReply
  }
  return -1
}

/** Last assistant bubble still marked running (HISTORY remaps ids; replyId can miss). */
function findRunningActivityIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant' && m.activity?.status === 'running') return i
  }
  return -1
}

/** Close a sticky trailing in_progress Plan item (N-1 completed + 1 in_progress). */
function reconcileStickyTodoSteps(steps: ChatActivityStep[]): ChatActivityStep[] {
  return steps.map((st) => {
    const items = st.todoItems
    if (!items?.length) return st
    let completed = 0
    let inProgress = 0
    let pending = 0
    for (const it of items) {
      if (it.status === 'completed') completed += 1
      else if (it.status === 'in_progress') inProgress += 1
      else pending += 1
    }
    if (pending > 0 || inProgress !== 1 || completed !== items.length - 1) return st
    const todoItems = items.map((it) => (
      it.status === 'in_progress'
        ? { content: it.content, status: 'completed' as const }
        : it
    ))
    return {
      ...st,
      todoItems,
      preview: todoItems.map((it, i) => `${i + 1}. ☑ ${it.content}`).join('\n'),
    }
  })
}

function finalizeRunningActivity(
  activity: ChatActivity,
  opts: { status: 'success' | 'error'; error?: string; finishedAt?: number },
): ChatActivity {
  const finishedAt = opts.finishedAt ?? Date.now()
  const steps = opts.status === 'success'
    ? reconcileStickyTodoSteps(activity.steps)
    : activity.steps
  return {
    ...activity,
    status: opts.status,
    finishedAt,
    durationMs: Math.max(0, finishedAt - activity.startedAt),
    error: opts.error ?? activity.error,
    steps: steps.map((st) => (
      st.status === 'pending' || st.status === 'running'
        ? { ...st, status: opts.status === 'error' ? 'error' : 'success', finishedAt }
        : st
    )),
  }
}

function withActivityAt(
  messages: ChatMessage[],
  index: number,
  nextActivity: ChatActivity | undefined,
): ChatMessage[] {
  const cur = messages[index]
  if (!cur) return messages
  const next = [...messages]
  next[index] = { ...cur, activity: nextActivity }
  return next
}

function outcomeToStepStatus(
  decision: ApprovalCardOutcome['decision'],
): ChatActivityStep['status'] {
  switch (decision) {
    case 'allowed':
    case 'allowed-pinned':
      return 'success'
    case 'denied':
    case 'denied-revoked':
      return 'denied'
    case 'expired':
      return 'error'
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.kind) {
    case 'WS_STATUS':
      return { ...s, status: a.status }
    case 'INIT':
      return {
        ...s,
        agents: a.agents,
        agent: s.agent || a.defaultAgent,
        // Prefer the persisted localStorage threadId (SET_CLIENT_ID) over
        // the ephemeral WS mint — media uploads must match get-history rekey.
        clientId: s.clientId || a.clientId || null,
      }
    case 'SET_CLIENT_ID':
      return { ...s, clientId: a.clientId }
    case 'HISTORY':
      // Non-empty history is authoritative (refresh / reconnect).
      // Empty history must NOT wipe in-memory bubbles: after MESSAGES_TTL
      // the server drops .log but the tab may still show the transcript,
      // and new-conversation already clears via RESET_CONVERSATION.
      // Always adopt the sticky agent from the session meta.
      // Clear ephemeral run UI — ACTIVE_RUN (if any) re-applies next.
      //
      // Mid-flight guard: a late get-history must not wipe the live
      // placeholder / Running accordion. CLI agents (non-agim) take longer,
      // so mobile reconnect/bootstrap often races the in-flight turn —
      // remapping ids then lets DONE miss the bubble and leave status=running.
      if (a.messages.length > 0 && (s.currentReplyId != null || s.activeRunId != null)) {
        return {
          ...s,
          agent: a.agent || s.agent,
          planMode: a.planMode ?? s.planMode,
          thinkVariant: a.thinkVariant ?? s.thinkVariant,
          sessionModel: a.sessionModel ?? s.sessionModel,
          compactRate: a.compactRate ?? s.compactRate,
        }
      }
      return {
        ...s,
        messages: a.messages.length > 0 ? a.messages : s.messages,
        agent: a.agent || s.agent,
        currentReplyId: a.messages.length > 0 ? null : s.currentReplyId,
        activeRunId: a.messages.length > 0 ? null : s.activeRunId,
        planMode: a.planMode ?? s.planMode,
        thinkVariant: a.thinkVariant ?? s.thinkVariant,
        sessionModel: a.sessionModel ?? s.sessionModel,
        compactRate: a.compactRate ?? s.compactRate,
      }
    case 'PLAN_MODE':
      return { ...s, planMode: a.enabled }
    case 'THINK_MODE':
      return { ...s, thinkVariant: a.variant || 'auto' }
    case 'SESSION_MODEL':
      return { ...s, sessionModel: a.model || '' }
    case 'COMPACT_RATE':
      return { ...s, compactRate: a.rate || 'auto' }
    case 'ACTIVE_RUN': {
      // Replayed after HISTORY on reconnect/refresh. Bind the snapshot
      // onto the last assistant bubble (or create a streaming placeholder).
      const startedAt = a.startedAt
      const finishedAt = a.finishedAt
      const activity: ChatActivity = {
        runId: a.runId,
        status: a.status,
        startedAt,
        finishedAt,
        durationMs: a.durationMs ?? (finishedAt != null ? Math.max(0, finishedAt - startedAt) : undefined),
        error: a.error,
        steps: a.steps,
      }
      let messages = [...s.messages]
      let replyId = s.currentReplyId
      let idx = findActivityMessageIndex(messages, { runId: a.runId, replyId })
      if (idx < 0) {
        // Prefer last assistant; else append a placeholder for in-flight.
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === 'assistant') { idx = i; break }
        }
      }
      if (idx < 0 && (a.status === 'running' || a.partialText)) {
        const placeholder: ChatMessage = {
          id: `reply-restore-${a.runId}`,
          role: 'assistant',
          content: a.partialText,
          agent: a.agent,
          timestamp: startedAt,
          activity,
        }
        messages = [...messages, placeholder]
        replyId = placeholder.id
        idx = messages.length - 1
      } else if (idx >= 0) {
        const cur = messages[idx]
        if (cur) {
          const id = a.status === 'running' ? `reply-restore-${a.runId}` : cur.id
          messages[idx] = {
            ...cur,
            id,
            content: a.partialText || cur.content,
            agent: cur.agent || a.agent,
            activity,
          }
          replyId = id
        }
      }
      const runRow: RunActivity = {
        runId: a.runId,
        agent: a.agent,
        startedAt,
        status: a.status,
        finishedAt,
        durationMs: activity.durationMs,
        outputChars: a.partialText.length || undefined,
        error: a.error,
      }
      const runActivities = [
        runRow,
        ...s.runActivities.filter((r) => r.runId !== a.runId),
      ].slice(0, MAX_RUN_ACTIVITIES)
      return {
        ...s,
        messages,
        agent: a.agent || s.agent,
        runActivities,
        activeRunId: a.status === 'running' ? a.runId : null,
        currentReplyId: a.status === 'running' ? replyId : null,
      }
    }
    case 'AGENTS':
      return { ...s, agents: a.agents }
    case 'AGENT_SWITCHED':
      return { ...s, agent: a.agent }
    case 'SEND_USER':
      return {
        ...s,
        messages: [...s.messages, a.message, a.placeholder],
        currentReplyId: a.placeholder.id,
        error: null,
      }
    case 'CHUNK': {
      // Append text to the current streaming reply.
      const idx = s.messages.findIndex((m) => m.id === a.replyId)
      if (idx < 0) return s
      const next = [...s.messages]
      const target = next[idx]
      if (target) {
        next[idx] = { ...target, content: target.content + a.text }
      }
      return { ...s, messages: next }
    }
    case 'DONE': {
      // Prefer runId (server always sends it) so HISTORY remaps / stale
      // replyId refs still close the Running accordion — especially for
      // CLI agents where reconnect races are common.
      let idx = findActivityMessageIndex(s.messages, {
        runId: a.runId,
        replyId: a.replyId || s.currentReplyId,
      })
      if (idx < 0) idx = findRunningActivityIndex(s.messages)
      if (idx < 0) return { ...s, currentReplyId: null, activeRunId: null }
      const next = [...s.messages]
      const target = next[idx]
      if (target) {
        // Server's `done` ships the full text — prefer it over the
        // accumulated chunks so we recover from any chunk we dropped.
        let activity = target.activity
        // If run-finish was dropped / delayed (common with some CLI
        // agents), close the accordion so the portal leaves Running…
        if (activity && activity.status === 'running') {
          const interrupted = a.finalText.includes('用户打断了执行')
          activity = finalizeRunningActivity(activity, {
            status: interrupted ? 'error' : 'success',
            error: interrupted ? '用户打断了执行' : undefined,
          })
        }
        next[idx] = {
          ...target,
          content: a.finalText || target.content,
          activity,
          ...(a.messageId ? { id: a.messageId } : {}),
        }
      }
      return { ...s, messages: next, currentReplyId: null, activeRunId: null }
    }
    case 'ERROR': {
      let messages = s.messages
      const idx = findActivityMessageIndex(messages, {
        replyId: s.currentReplyId,
        runId: s.activeRunId,
      })
      if (idx >= 0) {
        const msg = messages[idx]
        if (msg?.activity && msg.activity.status === 'running') {
          const finishedAt = Date.now()
          messages = withActivityAt(messages, idx, {
            ...msg.activity,
            status: 'error',
            finishedAt,
            durationMs: finishedAt - msg.activity.startedAt,
            error: a.message,
            steps: msg.activity.steps.map((st) => (
              st.status === 'pending' || st.status === 'running'
                ? { ...st, status: 'error', finishedAt }
                : st
            )),
          })
        }
      }
      return { ...s, messages, error: a.message, currentReplyId: null }
    }
    case 'APPROVAL_CARD': {
      // v1.2.115 — dock-only. Don't pollute the chat stream; the dock
      // renders these. Dedupe by messageId in case server replays.
      if (s.pendingApprovals.some((p) => p.messageId === a.messageId)) return s
      let messages = s.messages
      const idx = findActivityMessageIndex(messages, {
        replyId: s.currentReplyId,
        runId: s.activeRunId,
      })
      if (idx >= 0) {
        const msg = messages[idx]
        if (msg) {
          const base: ChatActivity = msg.activity ?? {
            runId: s.activeRunId ?? `pending-${a.messageId}`,
            status: 'running',
            startedAt: Date.now(),
            steps: [],
          }
          if (!base.steps.some((st) => st.id === a.messageId)) {
            messages = withActivityAt(messages, idx, {
              ...base,
              steps: [
                ...base.steps,
                {
                  id: a.messageId,
                  kind: 'approval',
                  label: a.prompt.toolName,
                  status: 'pending',
                  startedAt: Date.now(),
                  preview: a.prompt.inputJson,
                },
              ],
            })
          }
        }
      }
      return {
        ...s,
        messages,
        pendingApprovals: [
          ...s.pendingApprovals,
          { messageId: a.messageId, prompt: a.prompt },
        ],
      }
    }
    case 'APPROVAL_TEXT':
      // v1.2.115 — legacy text-fallback (no buttons, used by adapters
      // without sendApprovalCard, or for receipt strings like "已批准
      // 并启用自动放行"). The hook surfaces these via the toast layer
      // (handled in the WS-message dispatcher below); the reducer
      // intentionally doesn't store them. Receipts are transient
      // notifications, not chat content.
      return s
    case 'APPROVAL_EDIT': {
      // Mark resolved on the dock entry; the dock effect auto-dismisses
      // after a short delay so the user sees the ✅/❌/⏱ transition.
      const idx = s.pendingApprovals.findIndex((p) => p.messageId === a.messageId)
      if (idx < 0) return s
      const nextApprovals = [...s.pendingApprovals]
      const cur = nextApprovals[idx]
      if (cur) {
        nextApprovals[idx] = { ...cur, outcome: a.outcome, resolvedAt: Date.now() }
      }
      let messages = s.messages
      const msgIdx = findActivityMessageIndex(messages, {
        replyId: s.currentReplyId,
        runId: s.activeRunId,
      })
      if (msgIdx >= 0) {
        const msg = messages[msgIdx]
        if (msg?.activity) {
          const stepStatus = outcomeToStepStatus(a.outcome.decision)
          messages = withActivityAt(messages, msgIdx, {
            ...msg.activity,
            steps: msg.activity.steps.map((st) => (
              st.id === a.messageId
                ? { ...st, status: stepStatus, finishedAt: Date.now() }
                : st
            )),
          })
        }
      }
      return { ...s, messages, pendingApprovals: nextApprovals }
    }
    case 'APPROVAL_DISMISS':
      return {
        ...s,
        pendingApprovals: s.pendingApprovals.filter((p) => p.messageId !== a.messageId),
      }
    case 'CHOICE_CARD': {
      // Dock-only, mirroring APPROVAL_CARD. Dedupe by messageId.
      if (s.pendingAsks.some((p) => p.messageId === a.messageId)) return s
      let messages = s.messages
      const idx = findActivityMessageIndex(messages, {
        replyId: s.currentReplyId,
        runId: s.activeRunId,
      })
      if (idx >= 0) {
        const msg = messages[idx]
        if (msg) {
          const base: ChatActivity = msg.activity ?? {
            runId: s.activeRunId ?? `pending-${a.messageId}`,
            status: 'running',
            startedAt: Date.now(),
            steps: [],
          }
          if (!base.steps.some((st) => st.id === a.messageId)) {
            const label = a.prompt.title || a.prompt.body.slice(0, 48) || 'ask_user'
            messages = withActivityAt(messages, idx, {
              ...base,
              steps: [
                ...base.steps,
                {
                  id: a.messageId,
                  kind: 'ask',
                  label,
                  status: 'pending',
                  startedAt: Date.now(),
                  preview: a.prompt.body,
                },
              ],
            })
          }
        }
      }
      return {
        ...s,
        messages,
        pendingAsks: [...s.pendingAsks, { messageId: a.messageId, prompt: a.prompt }],
      }
    }
    case 'CHOICE_EDIT': {
      const idx = s.pendingAsks.findIndex((p) => p.messageId === a.messageId)
      if (idx < 0) return s
      const nextAsks = [...s.pendingAsks]
      const cur = nextAsks[idx]
      if (cur) nextAsks[idx] = { ...cur, finalText: a.finalText, resolvedAt: Date.now() }
      let messages = s.messages
      const msgIdx = findActivityMessageIndex(messages, {
        replyId: s.currentReplyId,
        runId: s.activeRunId,
      })
      if (msgIdx >= 0) {
        const msg = messages[msgIdx]
        if (msg?.activity) {
          messages = withActivityAt(messages, msgIdx, {
            ...msg.activity,
            steps: msg.activity.steps.map((st) => (
              st.id === a.messageId
                ? { ...st, status: 'success', finishedAt: Date.now(), preview: a.finalText }
                : st
            )),
          })
        }
      }
      return { ...s, messages, pendingAsks: nextAsks }
    }
    case 'CHOICE_DISMISS':
      return {
        ...s,
        pendingAsks: s.pendingAsks.filter((p) => p.messageId !== a.messageId),
      }
    case 'RUN_START': {
      const nextRuns: RunActivity[] = [
        {
          runId: a.runId,
          agent: a.agent,
          startedAt: a.startedAt,
          status: 'running',
        },
        ...s.runActivities.filter((r) => r.runId !== a.runId),
      ]
      let messages = s.messages
      let idx = findActivityMessageIndex(messages, { replyId: s.currentReplyId })
      if (idx < 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === 'assistant') { idx = i; break }
        }
      }
      if (idx >= 0) {
        const msg = messages[idx]
        if (msg) {
          messages = withActivityAt(messages, idx, {
            runId: a.runId,
            status: 'running',
            startedAt: a.startedAt,
            steps: msg.activity?.steps ?? [],
          })
        }
      }
      return {
        ...s,
        messages,
        runActivities: nextRuns.slice(0, MAX_RUN_ACTIVITIES),
        activeRunId: a.runId,
      }
    }
    case 'RUN_USAGE': {
      const idx = s.runActivities.findIndex((r) => r.runId === a.runId)
      let runActivities = s.runActivities
      if (idx >= 0) {
        const next = [...s.runActivities]
        const cur = next[idx]
        if (cur) {
          next[idx] = {
            ...cur,
            durationMs: a.durationMs,
            outputChars: a.outputChars,
          }
        }
        runActivities = next
      }
      let messages = s.messages
      const msgIdx = findActivityMessageIndex(messages, { runId: a.runId, replyId: s.currentReplyId })
      if (msgIdx >= 0) {
        const msg = messages[msgIdx]
        if (msg?.activity) {
          messages = withActivityAt(messages, msgIdx, {
            ...msg.activity,
            durationMs: a.durationMs,
            outputChars: a.outputChars,
          })
        }
      }
      return { ...s, runActivities, messages }
    }
    case 'RUN_FINISH': {
      const idx = s.runActivities.findIndex((r) => r.runId === a.runId)
      let runActivities = s.runActivities
      if (idx >= 0) {
        const next = [...s.runActivities]
        const cur = next[idx]
        if (cur) {
          next[idx] = {
            ...cur,
            status: a.status,
            finishedAt: a.finishedAt,
            durationMs: a.durationMs,
            error: a.error,
          }
        }
        runActivities = next
      }
      let messages = s.messages
      const msgIdx = findActivityMessageIndex(messages, { runId: a.runId, replyId: s.currentReplyId })
      if (msgIdx >= 0) {
        const msg = messages[msgIdx]
        if (msg?.activity) {
          messages = withActivityAt(
            messages,
            msgIdx,
            finalizeRunningActivity(msg.activity, {
              status: a.status,
              finishedAt: a.finishedAt,
              error: a.error,
            }),
          )
        }
      }
      return {
        ...s,
        messages,
        runActivities,
        activeRunId: s.activeRunId === a.runId ? null : s.activeRunId,
        // done may have been dropped; clear streaming once the run finishes.
        currentReplyId: (s.activeRunId === a.runId || msgIdx >= 0)
          ? null
          : s.currentReplyId,
      }
    }
    case 'ACTIVITY_STEP': {
      let messages = s.messages
      let idx = findActivityMessageIndex(messages, {
        runId: a.runId,
        replyId: s.currentReplyId,
      })
      if (idx < 0 && s.currentReplyId) {
        idx = messages.findIndex((m) => m.id === s.currentReplyId)
      }
      if (idx < 0) return s
      const msg = messages[idx]
      if (!msg) return s
      const base: ChatActivity = msg.activity ?? {
        runId: a.runId,
        status: 'running',
        startedAt: a.step.startedAt,
        steps: [],
      }
      const existing = base.steps.findIndex((st) => st.id === a.step.id)
      const steps = [...base.steps]
      const prev = existing >= 0 ? steps[existing] : undefined
      if (prev) {
        steps[existing] = {
          ...prev,
          ...a.step,
          // Keep earliest start; prefer newer preview/status/finishedAt.
          startedAt: Math.min(prev.startedAt, a.step.startedAt),
          preview: a.step.preview ?? prev.preview,
          todoItems: a.step.todoItems ?? prev.todoItems,
        }
      } else {
        steps.push(a.step)
      }
      messages = withActivityAt(messages, idx, {
        ...base,
        runId: a.runId || base.runId,
        status: base.status === 'running' ? 'running' : base.status,
        steps,
      })
      return { ...s, messages }
    }
    case 'RESET_CONVERSATION':
      // Clear all chat state but keep WS status + agent list + current
      // agent. Pending dock entries also clear — server's empty
      // history reply takes over rendering.
      return {
        ...s,
        messages: [],
        pendingApprovals: [],
        pendingAsks: [],
        runActivities: [],
        activeRunId: null,
        currentReplyId: null,
        error: null,
        planMode: false,
        thinkVariant: 'auto',
        sessionModel: '',
        compactRate: 'auto',
      }
    case 'CLEAR_ERROR':
      return { ...s, error: null }
  }
}
