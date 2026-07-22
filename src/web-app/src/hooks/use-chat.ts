/**
 * useChat — single hook driving the /chat route. Wires the WebSocket
 * (lib/api/ws.ts) into a useReducer state machine that holds the
 * message list, in-flight streaming chunk, available agents, and
 * approval cards.
 *
 * Stream throttling: every `chunk` event accumulates into a ref and
 * flushes to React state via requestAnimationFrame, so a 60 tps token
 * stream doesn't render 60 times a second (each setState costs
 * roughly a reconciliation pass — at 60fps that's the budget gone).
 *
 * The user-driven `send` API is intentionally optimistic: appending
 * the user message + an empty assistant placeholder happens
 * immediately, then the WS chunk/done events fill in the assistant
 * text. If the WS isn't OPEN we surface an error toast (caller).
 */

import { useEffect, useReducer, useRef } from 'react'
import { toast } from 'sonner'
import { openChatWs, type WsStatus } from '@/lib/api/ws'
import type { ApprovalCardOutcome, ApprovalCardPrompt, ChatIncoming, ChoiceCardPrompt } from '@/types/ws'
import i18n from '@/i18n'

/** v1.2.115 — how long the resolved card lingers in the dock before
 *  auto-dismiss. Long enough to read the ✅/❌ flip, short enough to
 *  not feel sluggish; matches sonner's default toast duration so the
 *  toast and the card fade out around the same time. */
const APPROVAL_DISMISS_AFTER_MS = 1200

export type MessageRole = 'user' | 'assistant' | 'system'

/** Three click outcomes the chat surface sends back. Maps 1:1 to the
 *  callback_data trailing letter that approval-router expects:
 *    `y` → allow
 *    `n` → deny
 *    `a` → allow + auto-allow further (the "Auto for similar" button) */
export type ApprovalChoice = 'y' | 'n' | 'a'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  agent?: string
  timestamp: number
  /** In-thread run accordion (tool/approval steps) for this assistant turn. */
  activity?: ChatActivity
  /** Approval cards land here as a system message with embedded data.
   *  `prompt` is the full structured payload from the server (toolName,
   *  inputJson, mode, graceSeconds, reqId). `text` is a plain string
   *  used for the legacy approval-text fallback path. */
  approval?: {
    messageId: string
    prompt?: ApprovalCardPrompt
    /** Legacy `approval-text` body (no buttons, no tool input). */
    text?: string
    outcome?: ApprovalCardOutcome
  }
}

/** One step inside a ChatActivity accordion (tool / approval / ask). */
export interface ChatActivityStep {
  id: string
  kind: 'tool' | 'approval' | 'ask' | 'skill' | 'status' | 'agent'
  label: string
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  startedAt: number
  finishedAt?: number
  preview?: string
}

/** Cursor-style “Worked ›” block bound to an assistant reply. */
export interface ChatActivity {
  runId: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  outputChars?: number
  error?: string
  steps: ChatActivityStep[]
}

/**
 * v1.2.115 — approval cards moved out of the chat message stream into a
 * floating dock above the input. PendingApproval is the dock's row
 * shape: messageId + prompt + optional outcome (set when the server's
 * approval-card-edit lands; triggers a toast and a brief auto-dismiss).
 */
export interface PendingApproval {
  messageId: string
  prompt: ApprovalCardPrompt
  /** Set when the bus resolves. Holding the outcome briefly (vs
   *  immediate removal) gives the user a visible state flip
   *  (✅/❌/⏱) before the row fades. */
  outcome?: ApprovalCardOutcome
  /** Bookkeeping for the timed dismiss. Optional — managed in the
   *  reducer's APPROVAL_EDIT branch via setTimeout. */
  resolvedAt?: number
}

/**
 * ask_user (choice) cards share the approval dock's lifecycle: shown while
 * pending, briefly flipped to a resolved state, then auto-dismissed. Unlike
 * approvals, the resolution carries a short `finalText` receipt rather than a
 * structured outcome.
 */
export interface PendingAsk {
  messageId: string
  prompt: ChoiceCardPrompt
  /** Set when the bus resolves (answer accepted, or timed out). Holding it
   *  briefly gives the user a visible "已发送 / 已失效" flip before the row
   *  fades. */
  finalText?: string
  resolvedAt?: number
}

export interface RunActivity {
  runId: string
  agent: string
  startedAt: number
  status: 'running' | 'success' | 'error'
  finishedAt?: number
  durationMs?: number
  outputChars?: number
  error?: string
}

export interface ChatState {
  messages: ChatMessage[]
  /** Active approval cards rendered in the dock (NOT in `messages`).
   *  v1.2.115 — previously approvals lived inline as system messages,
   *  but resolved cards lingered in history clutter. Dock approach:
   *  show only while pending → toast on resolve → dismiss. */
  pendingApprovals: PendingApproval[]
  /** Active ask_user (choice) cards rendered in the dock alongside
   *  approvals. Same show-while-pending → flip → dismiss lifecycle. */
  pendingAsks: PendingAsk[]
  /** Timeline rows for recent run lifecycle updates (run-start →
   *  usage → run-finish). Newest first, bounded list. */
  runActivities: RunActivity[]
  /** Current in-flight run id, if any. */
  activeRunId: string | null
  agents: string[]
  agent: string                  // currently selected
  status: WsStatus
  /** When non-null, an assistant message is being streamed; chunks
   *  accumulate into messages[currentReplyId].content. */
  currentReplyId: string | null
  error: string | null
  /** Live session plan-mode flag (from history / plan-mode events). */
  planMode: boolean
  /** Live session /think variant (from history / think-mode events). */
  thinkVariant: string
  /** Live session `/model` backend name (empty = native-chat role default). */
  sessionModel: string
  /** Live session `/ctx` compression rate (`auto` | `full` | `balanced` | `frequent`). */
  compactRate: string
  /** WebSocket thread id (web-…). Used for media upload subdir. */
  clientId: string | null
}

const initialState: ChatState = {
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

type Action =
  | { kind: 'WS_STATUS'; status: WsStatus }
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
  | { kind: 'DONE'; replyId: string; finalText: string; runId?: string }
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

const MAX_RUN_ACTIVITIES = 24

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

function finalizeRunningActivity(
  activity: ChatActivity,
  opts: { status: 'success' | 'error'; error?: string; finishedAt?: number },
): ChatActivity {
  const finishedAt = opts.finishedAt ?? Date.now()
  return {
    ...activity,
    status: opts.status,
    finishedAt,
    durationMs: Math.max(0, finishedAt - activity.startedAt),
    error: opts.error ?? activity.error,
    steps: activity.steps.map((st) => (
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

function reducer(s: ChatState, a: Action): ChatState {
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
        next[idx] = { ...target, content: a.finalText || target.content, activity }
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
          messages = withActivityAt(messages, msgIdx, {
            ...msg.activity,
            status: a.status,
            finishedAt: a.finishedAt,
            durationMs: a.durationMs,
            error: a.error,
            steps: msg.activity.steps.map((st) => (
              st.status === 'pending' || st.status === 'running'
                ? { ...st, status: a.status === 'success' ? 'success' : 'error', finishedAt: a.finishedAt }
                : st
            )),
          })
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

/** Surface a one-line resolution outcome via sonner. Keep these short:
 *  the dock row itself already shows the colored badge; the toast is
 *  the lingering confirmation when the row fades. */
function toastForOutcome(o: ApprovalCardOutcome): void {
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

let messageCounter = 0
function mkId(prefix: string): string {
  messageCounter += 1
  return `${prefix}-${Date.now()}-${messageCounter}`
}

/** Pure exports for unit tests. The hook itself is the public
 *  interface; these let test files exercise the reducer directly
 *  without spinning up a WebSocket. */
export { reducer as chatReducer, initialState as initialChatState }
export type ChatAction = Action

export interface UseChat {
  state: ChatState
  send: (text: string) => void
  /** Abort the in-flight web run (composer Stop button). */
  stop: () => void
  switchAgent: (name: string) => void
  /** Approval card button click. The hook composes the
   *  `apv:<reqId>:<y|n|a>` callback_data that approval-router expects;
   *  callers only pass the messageId + reqId + the user's choice.
   *  Returns whether the WS send actually went out — false means the
   *  socket was reconnecting and the click should be re-tried. The
   *  hook also dispatches an ERROR for the chat surface to render. */
  approvalClick: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean
  /** ask_user (choice) card answer. `data` is the fully-formed
   *  `ask:<reqId>:…` callback the AskDock built (single/multi/custom).
   *  Returns whether the WS send went out; on success the hook
   *  optimistically resolves + dismisses the dock row, since the bus
   *  doesn't push a card edit back for asks. */
  choiceSubmit: (messageId: string, data: string) => boolean
  /** Drop all messages + tell the server to fork a new session
   *  (resetConversation: new id, drops CLI session pins + auto-allow
   *  rules + plan-mode). The server replies with empty history. */
  newConversation: () => void
  clearError: () => void
}

export function useChat(): UseChat {
  const [state, dispatch] = useReducer(reducer, initialState)
  const wsRef = useRef(openChatWs())
  // Per-stream buffer + rAF token; chunks accumulate then flush once
  // per frame so we avoid 60 setState/sec.
  const chunkBuf = useRef<Map<string, string>>(new Map())
  const flushScheduled = useRef(false)
  // Mirror of state.currentReplyId, kept current so bufferChunk doesn't
  // read a stale closure value. Without this, the WS subscription
  // (mounted once with useEffect([])) captures the first-render `state`
  // where currentReplyId is null, every chunk gets early-returned, and
  // the assistant bubble stays stuck on "…" until React re-renders for
  // an unrelated reason (e.g. tab switch).
  const currentReplyIdRef = useRef<string | null>(null)
  useEffect(() => {
    currentReplyIdRef.current = state.currentReplyId
  }, [state.currentReplyId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the module-level socket subscription is intentionally mount-scoped; message handling reads mutable stream state through refs
  useEffect(() => {
    const ws = wsRef.current
    const off1 = ws.subscribe({
      type: 'status',
      fn: (status) => dispatch({ kind: 'WS_STATUS', status }),
    })
    const off2 = ws.subscribe({
      type: 'message',
      fn: (msg: ChatIncoming) => onIncoming(msg),
    })
    // 2026-05-19: persist a per-browser threadId so refresh / re-open
    // resumes the same server-side session. Generated once on first
    // chat and stored in localStorage; sent with every `get-history`.
    // Server falls back to its own clientId if we don't send one.
    function loadOrCreateThreadId(): string {
      try {
        const existing = localStorage.getItem('agim-web-thread-id')
        if (existing && /^web-[A-Za-z0-9_-]{4,64}$/.test(existing)) return existing
      } catch { /* private mode */ }
      const fresh = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      try { localStorage.setItem('agim-web-thread-id', fresh) } catch { /* ignore */ }
      return fresh
    }
    const threadId = loadOrCreateThreadId()
    dispatch({ kind: 'SET_CLIENT_ID', clientId: threadId })

    // On every WS open, ask the backend to:
    //   * replay history (rekey session to our persisted threadId)
    //   * re-send the agents list — the WS connection is a module-level
    //     singleton, so the server's `init` (agents + clientId) only
    //     fires on the FIRST mount of the whole app. When the user
    //     navigates away from /chat and back, `useChat()` re-mounts with
    //     a fresh empty reducer state but the WS doesn't re-emit `init`,
    //     leaving the agent picker empty. `get-agents` re-publishes.
    //
    // Re-bootstrap on EVERY open (not just the first): mobile visibility
    // reconnect and network blips mint a new server clientId. Without a
    // fresh get-history rekey, subsequent turns land under a different
    // session key and refresh cannot load the previous conversation.
    function bootstrap(): void {
      ws.send({ type: 'get-history', threadId })
      ws.send({ type: 'get-agents' })
    }
    // subscribe() replays the current status, so an already-open socket
    // still triggers bootstrap on mount. Keep the listener for later
    // reconnects (do not unsubscribe after the first open).
    const off3 = ws.subscribe({
      type: 'status',
      fn: (s) => {
        if (s === 'open') bootstrap()
      },
    })
    return () => { off1(); off2(); off3() }
  }, [])

  function onIncoming(msg: ChatIncoming): void {
    switch (msg.type) {
      case 'init':
        dispatch({
          kind: 'INIT',
          agents: msg.agents,
          defaultAgent: msg.defaultAgent,
          clientId: msg.clientId,
        })
        return
      case 'history':
        dispatch({
          kind: 'HISTORY',
          agent: msg.agent,
          planMode: msg.planMode,
          thinkVariant: msg.thinkVariant,
          sessionModel: msg.sessionModel,
          compactRate: msg.compactRate,
          messages: msg.messages.map((h, i): ChatMessage => {
            const activity = h.activity
              ? {
                  runId: h.activity.runId,
                  status: h.activity.status,
                  startedAt: h.activity.startedAt,
                  finishedAt: h.activity.finishedAt,
                  durationMs: h.activity.durationMs,
                  error: h.activity.error,
                  steps: h.activity.steps.map((st): ChatActivityStep => ({
                    id: st.id,
                    kind: st.kind === 'skill' || st.kind === 'status'
                      || st.kind === 'approval' || st.kind === 'ask'
                      || st.kind === 'agent'
                      ? st.kind
                      : 'tool',
                    label: st.label,
                    status: st.status,
                    startedAt: typeof st.startedAt === 'number'
                      ? st.startedAt
                      : (Number.isFinite(Date.parse(String(st.startedAt)))
                          ? Date.parse(String(st.startedAt))
                          : Date.now()),
                    finishedAt: st.finishedAt == null
                      ? undefined
                      : typeof st.finishedAt === 'number'
                        ? st.finishedAt
                        : (Number.isFinite(Date.parse(String(st.finishedAt)))
                            ? Date.parse(String(st.finishedAt))
                            : undefined),
                    preview: st.preview,
                  })),
                }
              : undefined
            return {
              id: `hist-${i}`,
              role: h.role,
              content: h.content,
              agent: h.agent,
              timestamp: h.timestamp ? Date.parse(h.timestamp) : Date.now() - i * 1000,
              activity,
            }
          }),
        })
        return
      case 'plan-mode':
        dispatch({ kind: 'PLAN_MODE', enabled: !!msg.enabled })
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
      case 'active-run': {
        const normStep = (st: (typeof msg.steps)[number]): ChatActivityStep => ({
          id: st.id,
          kind: st.kind === 'skill' || st.kind === 'status'
            || st.kind === 'approval' || st.kind === 'ask'
            || st.kind === 'agent'
            ? st.kind
            : 'tool',
          label: st.label,
          status: st.status,
          startedAt: typeof st.startedAt === 'number'
            ? st.startedAt
            : (Number.isFinite(Date.parse(String(st.startedAt)))
                ? Date.parse(String(st.startedAt))
                : Date.now()),
          finishedAt: st.finishedAt == null
            ? undefined
            : typeof st.finishedAt === 'number'
              ? st.finishedAt
              : (Number.isFinite(Date.parse(String(st.finishedAt)))
                  ? Date.parse(String(st.finishedAt))
                  : undefined),
          preview: st.preview,
        })
        dispatch({
          kind: 'ACTIVE_RUN',
          runId: msg.runId,
          agent: msg.agent,
          startedAt: Number.isFinite(Date.parse(msg.startedAt))
            ? Date.parse(msg.startedAt)
            : Date.now(),
          status: msg.status,
          steps: msg.steps.map(normStep),
          partialText: msg.partialText || '',
          finishedAt: msg.finishedAt && Number.isFinite(Date.parse(msg.finishedAt))
            ? Date.parse(msg.finishedAt)
            : undefined,
          durationMs: msg.durationMs,
          error: msg.error,
        })
        // Eagerly bind the streaming target so chunks that arrive before
        // the React effect syncing currentReplyIdRef are not dropped.
        currentReplyIdRef.current = msg.status === 'running'
          ? `reply-restore-${msg.runId}`
          : null
        return
      }
      case 'agents':
        dispatch({ kind: 'AGENTS', agents: msg.agents })
        return
      case 'agent-switched':
        dispatch({ kind: 'AGENT_SWITCHED', agent: msg.agent })
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
        const startedAt = typeof msg.step.startedAt === 'number'
          ? msg.step.startedAt
          : (Number.isFinite(Date.parse(String(msg.step.startedAt)))
              ? Date.parse(String(msg.step.startedAt))
              : Date.now())
        const finishedAt = msg.step.finishedAt == null
          ? undefined
          : typeof msg.step.finishedAt === 'number'
            ? msg.step.finishedAt
            : (Number.isFinite(Date.parse(String(msg.step.finishedAt)))
                ? Date.parse(String(msg.step.finishedAt))
                : undefined)
        dispatch({
          kind: 'ACTIVITY_STEP',
          runId: msg.runId,
          step: {
            id: msg.step.id,
            kind: msg.step.kind === 'skill' || msg.step.kind === 'status'
              || msg.step.kind === 'approval' || msg.step.kind === 'ask'
              || msg.step.kind === 'agent'
              ? msg.step.kind
              : 'tool',
            label: msg.step.label,
            status: msg.step.status,
            startedAt,
            finishedAt,
            preview: msg.step.preview,
          },
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
        })
        return
      case 'error':
        flushChunks()
        dispatch({ kind: 'ERROR', message: msg.message })
        return
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
        // fading out (driven by APPROVAL_DISMISS_AFTER_MS below); the
        // toast carries the outcome label so it stays visible after
        // the row vanishes.
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
      default:
        return
    }
  }

  function bufferChunk(text: string): void {
    const replyId = currentReplyIdRef.current
    if (!replyId) return
    const cur = chunkBuf.current.get(replyId) ?? ''
    chunkBuf.current.set(replyId, cur + text)
    if (flushScheduled.current) return
    flushScheduled.current = true
    requestAnimationFrame(() => {
      flushScheduled.current = false
      flushChunks()
    })
  }

  function flushChunks(): void {
    for (const [replyId, text] of chunkBuf.current.entries()) {
      if (text) dispatch({ kind: 'CHUNK', replyId, text })
    }
    chunkBuf.current.clear()
  }

  function send(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const ws = wsRef.current
    const userId = mkId('u')
    const replyId = mkId('a')
    // Bind before the React effect so early chunks / done from fast
    // agents (and late done after HISTORY races) still target this bubble.
    currentReplyIdRef.current = replyId
    dispatch({
      kind: 'SEND_USER',
      message: { id: userId, role: 'user', content: trimmed, timestamp: Date.now() },
      placeholder: {
        id: replyId,
        role: 'assistant',
        content: '',
        agent: state.agent,
        timestamp: Date.now(),
      },
    })
    const ok = ws.send({ type: 'message', text: trimmed, agent: state.agent })
    if (!ok) {
      dispatch({
        kind: 'ERROR',
        message: i18n.t('chat.notConnected', { ns: 'common', defaultValue: 'Not connected. Reconnecting…' }),
      })
    }
  }

  function switchAgent(name: string): void {
    wsRef.current.send({ type: 'switch-agent', agent: name })
  }

  function approvalClick(messageId: string, reqId: string, choice: ApprovalChoice): boolean {
    // approval-router parses `apv:<reqId>:<y|n|a>`. v1 composed this
    // client-side too; we route through unchanged because the router
    // is the canonical sink and ignores any other prefix.
    //
    // v1.2.88 — previously ignored ws.send()'s return value, which
    // meant a click during WS reconnect was silently dropped: the
    // user saw zero feedback and the approval card sat there
    // pending forever. Match the chat-send path (line 402): treat a
    // failed send as an explicit error so the user knows to wait
    // for reconnect and retry. The boolean return lets the calling
    // component clear its optimistic "submitting…" state.
    const ok = wsRef.current.send({
      type: 'approval-action',
      data: `apv:${reqId}:${choice}`,
      messageId,
    })
    if (!ok) {
      dispatch({
        kind: 'ERROR',
        message: i18n.t('chat.notConnectedRetry', {
          ns: 'common',
          defaultValue: 'Not connected. Reconnecting — try again in a moment.',
        }),
      })
    }
    return ok
  }

  /**
   * Submit an ask_user answer. `data` is the fully-formed `ask:<reqId>:…`
   * callback string (built by the AskDock component, since multi/custom
   * encoding lives next to the UI that knows the selection). ask-user-router
   * parses it; like approvalClick we route it through unchanged and treat a
   * failed send as an explicit error so the card can clear its optimistic
   * "submitting…" state.
   *
   * Unlike approvals, the bus does NOT push a card edit back when an ask
   * resolves (ask-user-rpc leaves the card alone — Telegram just acks the
   * tap, the TUI updates its own view). So the click IS the terminal state:
   * on a successful send we optimistically flip the dock row to a receipt
   * and dismiss it, otherwise it would sit "submitting" forever.
   */
  function choiceSubmit(messageId: string, data: string): boolean {
    const ok = wsRef.current.send({ type: 'choice-action', data, messageId })
    if (!ok) {
      dispatch({
        kind: 'ERROR',
        message: i18n.t('chat.notConnectedRetry', {
          ns: 'common',
          defaultValue: 'Not connected. Reconnecting — try again in a moment.',
        }),
      })
      return ok
    }
    dispatch({
      kind: 'CHOICE_EDIT',
      messageId,
      finalText: i18n.t('chat.askResolved', { ns: 'common', defaultValue: '✅ 已回答' }),
    })
    window.setTimeout(() => {
      dispatch({ kind: 'CHOICE_DISMISS', messageId })
    }, APPROVAL_DISMISS_AFTER_MS)
    return ok
  }

  function newConversation(): void {
    // Optimistic clear so the UI repaints empty immediately; the server's
    // follow-up `history` message with messages=[] reconfirms the state.
    dispatch({ kind: 'RESET_CONVERSATION' })
    wsRef.current.send({ type: 'new-conversation' })
  }

  function stop(): void {
    const ok = wsRef.current.send({ type: 'stop' })
    if (!ok) {
      dispatch({
        kind: 'ERROR',
        message: i18n.t('chat.notConnected', { ns: 'common', defaultValue: 'Not connected. Reconnecting…' }),
      })
    }
  }

  return {
    state,
    send,
    stop,
    switchAgent,
    approvalClick,
    choiceSubmit,
    newConversation,
    clearError: () => dispatch({ kind: 'CLEAR_ERROR' }),
  }
}
