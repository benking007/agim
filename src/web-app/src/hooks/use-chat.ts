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
import { openChatWs, type WsStatus } from '@/lib/api/ws'
import type { ApprovalCardOutcome, ApprovalCardPrompt, ChatIncoming } from '@/types/ws'

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

export interface ChatState {
  messages: ChatMessage[]
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
  | { kind: 'RESET_CONVERSATION' }
  | { kind: 'CLEAR_ERROR' }

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
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id: `approval-${a.messageId}`,
            role: 'system',
            content: '',
            timestamp: Date.now(),
            approval: { messageId: a.messageId, prompt: a.prompt },
          },
        ],
      }
    case 'APPROVAL_TEXT':
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id: `approval-${a.messageId}`,
            role: 'system',
            content: '',
            timestamp: Date.now(),
            approval: { messageId: a.messageId, text: a.text },
          },
        ],
      }
    case 'APPROVAL_EDIT': {
      const idx = s.messages.findIndex(
        (m) => m.approval?.messageId === a.messageId,
      )
      if (idx < 0) return s
      const next = [...s.messages]
      const cur = next[idx]
      if (cur?.approval) {
        next[idx] = { ...cur, approval: { ...cur.approval, outcome: a.outcome } }
      }
      return { ...s, messages: next }
    }
    case 'RESET_CONVERSATION':
      // Clear all chat state but keep WS status + agent list + current
      // agent. The server is the source of truth for messages; it
      // replies with an empty `history` after the reset, which we
      // optimistically pre-render.
      return {
        ...s,
        messages: [],
        currentReplyId: null,
        error: null,
      }
    case 'CLEAR_ERROR':
      return { ...s, error: null }
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
   *  callers only pass the messageId + reqId + the user's choice. */
  approvalClick: (messageId: string, reqId: string, choice: ApprovalChoice) => void
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
    if (ws.status() === 'open') bootstrap()
    else {
      // Wait for OPEN to ask — subscribe a one-shot.
      const off3 = ws.subscribe({
        type: 'status',
        fn: (s) => {
          if (s === 'open') {
            bootstrap()
            off3()
          }
        },
      })
      return () => {
        off1(); off2(); off3()
      }
    }

    return () => {
      off1(); off2()
    }
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
        return
      case 'approval-text':
        // approval-text is the legacy fallback path used by adapters
        // that can't render cards (or for "receipt" lines after a
        // card resolves). No reqId / toolName — just a string body.
        dispatch({
          kind: 'APPROVAL_TEXT',
          messageId: `text-${Date.now()}`,
          text: msg.text,
        })
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
      dispatch({ kind: 'ERROR', message: 'Not connected. Reconnecting…' })
    }
  }

  function switchAgent(name: string): void {
    wsRef.current.send({ type: 'switch-agent', agent: name })
  }

  function approvalClick(messageId: string, reqId: string, choice: ApprovalChoice): void {
    // approval-router parses `apv:<reqId>:<y|n|a>`. v1 composed this
    // client-side too; we route through unchanged because the router
    // is the canonical sink and ignores any other prefix.
    wsRef.current.send({
      type: 'approval-action',
      data: `apv:${reqId}:${choice}`,
      messageId,
    })
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
    newConversation,
    clearError: () => dispatch({ kind: 'CLEAR_ERROR' }),
  }
}
