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
 *
 * Implementation is split across sibling modules:
 *   chat/chat-types.ts       — shared types + constants
 *   chat/chat-reducer.ts     — pure reducer + initial state + action union
 *   chat/chat-ws-handlers.ts — WS frame normalization + onIncoming factory
 *   lib/web-history-cache.ts — localStorage snapshot for instant paint
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import i18n from '@/i18n'
import { openChatWs } from '@/lib/api/ws'
import {
  archiveSession as markSessionArchived,
  archiveSessionsForWorkspace,
  findSession,
  isSessionArchived,
  isWebThreadId,
  listSessions,
  loadTabThreadId,
  mintThreadId,
  sessionTitleFromText,
  setActiveId,
  subscribeSessions,
  upsertSession,
  type WebSessionEntry,
} from '@/lib/web-sessions'
import {
  CLOUD_WORKSPACE_ID,
  activeWorkspacePath,
  addLocalWorkspace,
  archiveLocalWorkspace,
  listWorkspaces,
  loadActiveWorkspaceId,
  setActiveWorkspace,
} from '@/lib/web-workspaces'
import {
  cachedHistoryToAction,
  hydrateInitialChatState,
  readCachedHistory,
  writeCachedHistory,
} from '@/lib/web-history-cache'
import { chatReducer, initialChatState } from './chat/chat-reducer'
import { makeOnIncoming } from './chat/chat-ws-handlers'
import { historyPersistSnap, usePersistChatHistory } from './chat/use-persist-chat-history'
import { APPROVAL_DISMISS_AFTER_MS } from './chat/chat-types'
import type { ApprovalChoice, ChatMessage, UseChat } from './chat/chat-types'
import { pullAccountSessions, pushAccountSession } from '@/lib/web-session-sync'
import type { ChatIncoming } from '@/types/ws'

// ---------------------------------------------------------------------------
// Re-export everything the existing consumers import from this module.
// Keeping use-chat.ts as the public facade means zero import-path breakage.
// ---------------------------------------------------------------------------
export type {
  MessageRole,
  ApprovalChoice,
  ChatMessage,
  ChatActivityStep,
  ChatActivity,
  PendingApproval,
  PendingAsk,
  RunActivity,
  ChatState,
  UseChat,
} from './chat/chat-types'
export type { WebSessionEntry } from '@/lib/web-sessions'
export { APPROVAL_DISMISS_AFTER_MS } from './chat/chat-types'
export { chatReducer, initialChatState, isCloudHistoryNewer, historyBelongsToClient } from './chat/chat-reducer'
export type { ChatAction } from './chat/chat-reducer'

// ---------------------------------------------------------------------------
// Module-level message counter for optimistic bubble ids
// ---------------------------------------------------------------------------
let messageCounter = 0
function mkId(prefix: string): string {
  messageCounter += 1
  return `${prefix}-${Date.now()}-${messageCounter}`
}

function snapshotSessions(): { sessions: WebSessionEntry[]; activeId: string } {
  return { sessions: listSessions(), activeId: loadTabThreadId() }
}

function transcriptHasUserTurn(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && m.content.trim())
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChat(): UseChat {
  const [state, dispatch] = useReducer(chatReducer, initialChatState, hydrateInitialChatState)
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
  // Always-current thread id for reconnect bootstrap + get-history.
  // Capturing a const in useEffect([]) used to rekey the *first* session
  // after New conversation / switch.
  const threadIdRef = useRef(loadTabThreadId())
  const messagesRef = useRef(state.messages)
  const [sessionSnap, setSessionSnap] = useState(snapshotSessions)
  const followIfRemoteSwitchedRef = useRef<() => void>(() => {})
  const pullRemoteRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    currentReplyIdRef.current = state.currentReplyId
  }, [state.currentReplyId])

  useEffect(() => {
    messagesRef.current = state.messages
  }, [state.messages])

  usePersistChatHistory(threadIdRef, state, messagesRef)

  useEffect(() => subscribeSessions(() => {
    setSessionSnap(snapshotSessions())
  }), [])

  useEffect(() => {
    let cancelled = false
    const pull = (): void => {
      if (cancelled) return
      void pullRemoteRef.current()
    }
    pull()
    function onVis(): void {
      if (document.visibilityState === 'visible') pull()
    }
    function onFocus(): void { pull() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') pull()
    }, 15_000)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const ws = wsRef.current
    const off1 = ws.subscribe({
      type: 'status',
      fn: (status) => dispatch({ kind: 'WS_STATUS', status }),
    })

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

    const onIncoming = makeOnIncoming(
      dispatch,
      currentReplyIdRef,
      bufferChunk,
      flushChunks,
      { threadIdRef },
    )
    const off2 = ws.subscribe({
      type: 'message',
      fn: (msg: ChatIncoming) => {
        if (msg.type === 'sessions-changed') {
          void pullRemoteRef.current()
          return
        }
        onIncoming(msg)
      },
    })

    // Persist this tab's threadId so refresh resumes the same server
    // session. Shared localStorage last-focused id is only a seed for
    // new tabs; this tab keeps `sessionStorage` so another window
    // switching sessions cannot steal the transcript.
    const threadId = loadTabThreadId()
    threadIdRef.current = threadId
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
    // Read threadIdRef so New conversation / switch survive reconnect.
    function bootstrap(): void {
      ws.send({ type: 'get-history', threadId: threadIdRef.current })
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
    const workspacePath = activeWorkspacePath()
    const ok = ws.send({
      type: 'message',
      text: trimmed,
      agent: state.agent,
      ...(workspacePath ? { workspacePath } : {}),
    })
    if (!ok) {
      dispatch({
        kind: 'ERROR',
        message: i18n.t('chat.notConnected', { ns: 'common', defaultValue: 'Not connected. Reconnecting…' }),
      })
    }
    const existing = findSession(threadIdRef.current)
    const title = existing?.title || sessionTitleFromText(trimmed)
    upsertSession({
      id: threadIdRef.current,
      updatedAt: Date.now(),
      agent: state.agent,
      ...(existing?.title ? {} : { title }),
    })
    void pushAccountSession({
      threadId: threadIdRef.current,
      ...(title ? { title } : {}),
      agent: state.agent,
    })
  }

  function steer(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const userId = mkId('u')
    dispatch({
      kind: 'APPEND_USER',
      message: { id: userId, role: 'user', content: trimmed, timestamp: Date.now() },
    })
    const ok = wsRef.current.send({ type: 'steer', text: trimmed })
    if (!ok) {
      dispatch({
        kind: 'ERROR',
        message: i18n.t('chat.notConnected', { ns: 'common', defaultValue: 'Not connected. Reconnecting…' }),
      })
    }
    upsertSession({
      id: threadIdRef.current,
      updatedAt: Date.now(),
      agent: state.agent,
    })
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

  function activateThread(threadId: string): void {
    writeCachedHistory(
      threadIdRef.current,
      historyPersistSnap(state, messagesRef.current),
    )
    setActiveId(threadId)
    threadIdRef.current = threadId
    currentReplyIdRef.current = null
    dispatch({ kind: 'RESET_CONVERSATION' })
    dispatch({ kind: 'SET_CLIENT_ID', clientId: threadId })
    const cached = readCachedHistory(threadId)
    if (cached) dispatch(cachedHistoryToAction(cached))
    wsRef.current.send({ type: 'get-history', threadId })
  }

  function newConversation(): void {
    // Already on a blank session — don't mint another empty thread.
    if (!transcriptHasUserTurn(messagesRef.current)) return
    const id = mintThreadId()
    upsertSession({
      id,
      updatedAt: Date.now(),
      agent: state.agent,
      workspaceId: loadActiveWorkspaceId(),
    })
    activateThread(id)
    syncWorkspace(activeWorkspacePath())
  }

  function startSessionInWorkspace(workspaceId: string): void {
    const current = findSession(threadIdRef.current)
    const blank = !transcriptHasUserTurn(messagesRef.current)
    if (blank && current) {
      upsertSession({ id: current.id, workspaceId })
      syncWorkspace(activeWorkspacePath())
      return
    }
    const id = mintThreadId()
    upsertSession({
      id,
      updatedAt: Date.now(),
      agent: state.agent,
      workspaceId,
    })
    activateThread(id)
    syncWorkspace(activeWorkspacePath())
  }

  /** New named folder only — re-picking an existing path does not mint. */
  function createWorkspace(dir: { name: string; path: string }): void {
    const path = dir.path.trim()
    const existed = listWorkspaces().some((w) => w.kind === 'local' && w.path === path)
    const ws = addLocalWorkspace(dir)
    if (ws.kind !== 'local') {
      syncWorkspace('')
      return
    }
    if (!existed) startSessionInWorkspace(ws.id)
    else syncWorkspace(ws.path || ws.name)
  }

  function syncWorkspace(path?: string): void {
    wsRef.current.send({ type: 'set-workspace', workspacePath: path || '' })
  }

  function switchSession(threadId: string): void {
    const id = threadId.trim()
    if (!isWebThreadId(id) || id === threadIdRef.current) return
    setActiveWorkspace(findSession(id)?.workspaceId || CLOUD_WORKSPACE_ID)
    activateThread(id)
    syncWorkspace(activeWorkspacePath())
  }

  function followVisibleSession(preferredId?: string): void {
    const next = (preferredId && listSessions().some((s) => s.id === preferredId) ? preferredId : undefined)
      || listSessions()[0]?.id
    if (next && next !== threadIdRef.current) {
      switchSession(next)
      return
    }
    if (next && next === threadIdRef.current) {
      syncWorkspace(activeWorkspacePath())
      return
    }
    const id = mintThreadId()
    upsertSession({
      id,
      updatedAt: Date.now(),
      agent: state.agent,
      workspaceId: loadActiveWorkspaceId(),
    })
    activateThread(id)
    syncWorkspace(activeWorkspacePath())
  }

  function archiveSession(threadId: string): void {
    const id = threadId.trim()
    if (!isWebThreadId(id)) return
    const wasActive = id === threadIdRef.current
    const index = markSessionArchived(id)
    void pushAccountSession({ threadId: id, archivedAt: Date.now() })
    if (!wasActive) return
    followVisibleSession(index.activeId)
  }

  function archiveWorkspace(workspaceId: string): void {
    const id = workspaceId.trim()
    if (!id || id === CLOUD_WORKSPACE_ID) return
    const currentId = threadIdRef.current
    const toArchive = listSessions(id)
    archiveSessionsForWorkspace(id)
    const now = Date.now()
    for (const s of toArchive) {
      void pushAccountSession({ threadId: s.id, archivedAt: now })
    }
    const next = archiveLocalWorkspace(id)
    const current = findSession(currentId)
    if (!current || isSessionArchived(current)) {
      setActiveWorkspace(CLOUD_WORKSPACE_ID)
      followVisibleSession()
      return
    }
    if (next.activeId === CLOUD_WORKSPACE_ID) syncWorkspace('')
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

  function stopSubagent(jobId: number): boolean {
    const ok = wsRef.current.send({ type: 'stop-subagent', jobId })
    if (!ok) {
      dispatch({
        kind: 'ERROR',
        message: i18n.t('chat.notConnected', { ns: 'common', defaultValue: 'Not connected. Reconnecting…' }),
      })
      return false
    }
    return true
  }

  /** Re-fetch history + active-run so a ghost pet "Running" can be restored or cleared. */
  function refreshHistory(): boolean {
    const threadId = threadIdRef.current
    if (!threadId) return false
    return wsRef.current.send({ type: 'get-history', threadId })
  }

  followIfRemoteSwitchedRef.current = () => {
    const next = loadTabThreadId()
    if (!isWebThreadId(next) || next === threadIdRef.current) return
    setActiveWorkspace(findSession(next)?.workspaceId || CLOUD_WORKSPACE_ID)
    activateThread(next)
    syncWorkspace(activeWorkspacePath())
  }
  pullRemoteRef.current = async () => {
    const ok = await pullAccountSessions(threadIdRef.current)
    if (!ok) return
    followIfRemoteSwitchedRef.current()
  }

  return {
    state,
    send,
    steer,
    stop,
    stopSubagent,
    refreshHistory,
    switchAgent,
    approvalClick,
    choiceSubmit,
    newConversation,
    switchSession,
    archiveSession,
    archiveWorkspace,
    syncWorkspace,
    createWorkspace,
    sessions: sessionSnap.sessions,
    activeSessionId: sessionSnap.activeId,
    clearError: () => dispatch({ kind: 'CLEAR_ERROR' }),
  }
}
