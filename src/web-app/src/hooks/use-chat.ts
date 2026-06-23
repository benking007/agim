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
}

type Action =
  | { kind: 'WS_STATUS'; status: WsStatus }
  | { kind: 'INIT'; agents: string[]; defaultAgent: string }
  | { kind: 'HISTORY'; messages: ChatMessage[]; agent: string }
  | { kind: 'AGENTS'; agents: string[] }
  | { kind: 'AGENT_SWITCHED'; agent: string }
  | { kind: 'SEND_USER'; message: ChatMessage; placeholder: ChatMessage }
  | { kind: 'CHUNK'; replyId: string; text: string }
  | { kind: 'DONE'; replyId: string; finalText: string }
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
  | { kind: 'RESET_CONVERSATION' }
  | { kind: 'CLEAR_ERROR' }

const MAX_RUN_ACTIVITIES = 24

function reducer(s: ChatState, a: Action): ChatState {
  switch (a.kind) {
    case 'WS_STATUS':
      return { ...s, status: a.status }
    case 'INIT':
      return { ...s, agents: a.agents, agent: s.agent || a.defaultAgent }
    case 'HISTORY':
      return { ...s, messages: a.messages, agent: a.agent }
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
      const idx = s.messages.findIndex((m) => m.id === a.replyId)
      if (idx < 0) return { ...s, currentReplyId: null }
      const next = [...s.messages]
      const target = next[idx]
      if (target) {
        // Server's `done` ships the full text — prefer it over the
        // accumulated chunks so we recover from any chunk we dropped.
        next[idx] = { ...target, content: a.finalText || target.content }
      }
      return { ...s, messages: next, currentReplyId: null }
    }
    case 'ERROR':
      return { ...s, error: a.message, currentReplyId: null }
    case 'APPROVAL_CARD':
      // v1.2.115 — dock-only. Don't pollute the chat stream; the dock
      // renders these. Dedupe by messageId in case server replays.
      if (s.pendingApprovals.some((p) => p.messageId === a.messageId)) return s
      return {
        ...s,
        pendingApprovals: [
          ...s.pendingApprovals,
          { messageId: a.messageId, prompt: a.prompt },
        ],
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
      const next = [...s.pendingApprovals]
      const cur = next[idx]
      if (cur) {
        next[idx] = { ...cur, outcome: a.outcome, resolvedAt: Date.now() }
      }
      return { ...s, pendingApprovals: next }
    }
    case 'APPROVAL_DISMISS':
      return {
        ...s,
        pendingApprovals: s.pendingApprovals.filter((p) => p.messageId !== a.messageId),
      }
    case 'CHOICE_CARD':
      // Dock-only, mirroring APPROVAL_CARD. Dedupe by messageId.
      if (s.pendingAsks.some((p) => p.messageId === a.messageId)) return s
      return {
        ...s,
        pendingAsks: [...s.pendingAsks, { messageId: a.messageId, prompt: a.prompt }],
      }
    case 'CHOICE_EDIT': {
      const idx = s.pendingAsks.findIndex((p) => p.messageId === a.messageId)
      if (idx < 0) return s
      const next = [...s.pendingAsks]
      const cur = next[idx]
      if (cur) next[idx] = { ...cur, finalText: a.finalText, resolvedAt: Date.now() }
      return { ...s, pendingAsks: next }
    }
    case 'CHOICE_DISMISS':
      return {
        ...s,
        pendingAsks: s.pendingAsks.filter((p) => p.messageId !== a.messageId),
      }
    case 'RUN_START': {
      const next: RunActivity[] = [
        {
          runId: a.runId,
          agent: a.agent,
          startedAt: a.startedAt,
          status: 'running',
        },
        ...s.runActivities.filter((r) => r.runId !== a.runId),
      ]
      return {
        ...s,
        runActivities: next.slice(0, MAX_RUN_ACTIVITIES),
        activeRunId: a.runId,
      }
    }
    case 'RUN_USAGE': {
      const idx = s.runActivities.findIndex((r) => r.runId === a.runId)
      if (idx < 0) return s
      const next = [...s.runActivities]
      const cur = next[idx]
      if (cur) {
        next[idx] = {
          ...cur,
          durationMs: a.durationMs,
          outputChars: a.outputChars,
        }
      }
      return { ...s, runActivities: next }
    }
    case 'RUN_FINISH': {
      const idx = s.runActivities.findIndex((r) => r.runId === a.runId)
      if (idx < 0) {
        return {
          ...s,
          activeRunId: s.activeRunId === a.runId ? null : s.activeRunId,
        }
      }
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
      return {
        ...s,
        runActivities: next,
        activeRunId: s.activeRunId === a.runId ? null : s.activeRunId,
      }
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

    // On mount, ask the backend to:
    //   * replay history (rekey session to our persisted threadId)
    //   * re-send the agents list — the WS connection is a module-level
    //     singleton, so the server's `init` (agents + clientId) only
    //     fires on the FIRST mount of the whole app. When the user
    //     navigates away from /chat and back, `useChat()` re-mounts with
    //     a fresh empty reducer state but the WS doesn't re-emit `init`,
    //     leaving the agent picker empty. `get-agents` re-publishes.
    function bootstrap(): void {
      ws.send({ type: 'get-history', threadId })
      ws.send({ type: 'get-agents' })
    }
    // R10: previously the open-branch returned a cleanup that only
    // unsubscribed off1/off2, while the not-open branch returned a
    // cleanup that ALSO unsubscribed the one-shot off3. Under
    // StrictMode + route hops (/chat → /tasks → /chat) the off1/off2
    // subscriptions leaked across remounts. Unify: always declare off3
    // (no-op when we already saw 'open'), always return a single
    // cleanup that drops all three.
    let off3: () => void = () => {}
    if (ws.status() === 'open') {
      bootstrap()
    } else {
      off3 = ws.subscribe({
        type: 'status',
        fn: (s) => {
          if (s === 'open') {
            bootstrap()
            off3()
          }
        },
      })
    }
    return () => { off1(); off2(); off3() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ws is module-singleton
  }, [])

  function onIncoming(msg: ChatIncoming): void {
    switch (msg.type) {
      case 'init':
        dispatch({ kind: 'INIT', agents: msg.agents, defaultAgent: msg.defaultAgent })
        return
      case 'history':
        dispatch({
          kind: 'HISTORY',
          agent: msg.agent,
          messages: msg.messages.map((h, i): ChatMessage => ({
            id: `hist-${i}`,
            role: h.role,
            content: h.content,
            agent: h.agent,
            timestamp: h.timestamp ? Date.parse(h.timestamp) : Date.now() - i * 1000,
          })),
        })
        return
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

  return {
    state,
    send,
    switchAgent,
    approvalClick,
    choiceSubmit,
    newConversation,
    clearError: () => dispatch({ kind: 'CLEAR_ERROR' }),
  }
}
