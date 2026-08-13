/**
 * Debounced localStorage persist of the idle transcript so refresh /
 * session switch can paint before get-history returns.
 */

import { useEffect, useRef } from 'react'
import { writeCachedHistory, type HistoryPersistSnap } from '@/lib/web-history-cache'
import type { ChatMessage, ChatState } from './chat-types'

export function historyPersistSnap(state: ChatState, messages: ChatMessage[]): HistoryPersistSnap {
  return {
    messages,
    agent: state.agent,
    preferredWorkerAgent: state.preferredWorkerAgent,
    planMode: state.planMode,
    thinkVariant: state.thinkVariant,
    sessionModel: state.sessionModel,
    compactRate: state.compactRate,
    revisionAt: state.historyRevisionAt,
  }
}

export function persistIdleHistory(
  expectedThreadId: string,
  liveThreadId: string,
  snap: HistoryPersistSnap,
): void {
  if (!expectedThreadId || expectedThreadId !== liveThreadId) return
  writeCachedHistory(expectedThreadId, snap)
}

export function usePersistChatHistory(
  threadIdRef: { current: string },
  state: ChatState,
  messagesRef: { current: ChatMessage[] },
): void {
  const stateRef = useRef(state)
  stateRef.current = state
  const tailSig = `${state.messages.length}:${state.messages.at(-1)?.id ?? ''}:${state.messages.at(-1)?.content.length ?? 0}`

  useEffect(() => {
    void tailSig
    if (state.currentReplyId != null || state.activeRunId != null) return
    const id = threadIdRef.current
    const timer = window.setTimeout(() => {
      persistIdleHistory(id, threadIdRef.current, historyPersistSnap(stateRef.current, messagesRef.current))
    }, 400)
    return () => window.clearTimeout(timer)
  }, [tailSig, state.currentReplyId, state.activeRunId, threadIdRef, messagesRef])

  useEffect(() => {
    const save = (): void => {
      const s = stateRef.current
      if (s.currentReplyId != null || s.activeRunId != null) return
      persistIdleHistory(threadIdRef.current, threadIdRef.current, historyPersistSnap(s, messagesRef.current))
    }
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') save()
    }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [threadIdRef, messagesRef])
}
