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
import type { ChatIncoming } from '@/types/ws'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  agent?: string
  timestamp: number
  /** Approval cards land here as a system message with embedded data. */
  approval?: {
    messageId: string
    prompt: string
    outcome?: 'allow' | 'deny' | 'timeout'
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
  | { kind: 'APPROVAL_CARD'; messageId: string; prompt: string }
  | { kind: 'APPROVAL_EDIT'; messageId: string; outcome: 'allow' | 'deny' | 'timeout' }
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
  approvalClick: (messageId: string, decision: 'allow' | 'deny') => void
  clearError: () => void
}

export function useChat(): UseChat {
  const [state, dispatch] = useReducer(reducer, initialState)
  const wsRef = useRef(openChatWs())
  // Per-stream buffer + rAF token; chunks accumulate then flush once
  // per frame so we avoid 60 setState/sec.
  const chunkBuf = useRef<Map<string, string>>(new Map())
  const flushScheduled = useRef(false)

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
    // On mount, ask the backend to replay history. The server's `init`
    // already sent agents + clientId; `get-history` triggers the
    // separate `history` message.
    if (ws.status() === 'open') ws.send({ type: 'get-history' })
    else {
      // Wait for OPEN to ask — subscribe a one-shot.
      const off3 = ws.subscribe({
        type: 'status',
        fn: (s) => {
          if (s === 'open') {
            ws.send({ type: 'get-history' })
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
          replyId: state.currentReplyId ?? '',
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
        // Surface as system message; reuse approval slot.
        dispatch({
          kind: 'APPROVAL_CARD',
          messageId: `text-${Date.now()}`,
          prompt: msg.text,
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
    const replyId = state.currentReplyId
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

  function approvalClick(messageId: string, decision: 'allow' | 'deny'): void {
    wsRef.current.send({ type: 'approval-action', data: decision, messageId })
  }

  return {
    state,
    send,
    switchAgent,
    approvalClick,
    clearError: () => dispatch({ kind: 'CLEAR_ERROR' }),
  }
}
