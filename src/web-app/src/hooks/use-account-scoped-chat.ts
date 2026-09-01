/**
 * When the signed-in usr_* changes, drop the previous account's Portal
 * transcript and mint a blank tab before the next paint.
 */

import { useLayoutEffect, useRef, type Dispatch, type MutableRefObject } from 'react'
import { useAuth } from '@/stores/auth'
import { syncWebAccountScope } from '@/lib/web-account-scope'
import { loadTabThreadId } from '@/lib/web-sessions'
import { clearComposerIslands } from '@/lib/portal-composer-islands'
import { clearChatIslands } from './chat/chat-session-islands'
import type { ChatOutgoing } from '@/types/ws'
import type { ChatAction } from './chat/chat-reducer'

interface AccountScopedWs {
  send: (msg: ChatOutgoing) => boolean
  reconnect?: () => void
}

export function useAccountScopedChat(
  threadIdRef: MutableRefObject<string>,
  currentReplyIdRef: MutableRefObject<string | null>,
  dispatch: Dispatch<ChatAction>,
  wsRef: { readonly current: AccountScopedWs },
  pullRemoteRef: MutableRefObject<() => Promise<void>>,
): void {
  const authReady = useAuth((s) => s.ready)
  const signedIn = useAuth((s) => s.signedIn)
  const accountUserId = useAuth((s) => s.user?.id ?? null)
  const scopedAccountRef = useRef<string | null | undefined>(undefined)

  useLayoutEffect(() => {
    if (!authReady) return
    // Token / loopback may be signedIn before /api/auth/me returns usr_*.
    if (signedIn && !accountUserId) return
    const switched = syncWebAccountScope(accountUserId)
    const accountChanged = scopedAccountRef.current !== undefined
      && scopedAccountRef.current !== accountUserId
    scopedAccountRef.current = accountUserId
    if (!switched && !accountChanged) return
    clearChatIslands()
    clearComposerIslands()
    const next = loadTabThreadId()
    threadIdRef.current = next
    currentReplyIdRef.current = null
    dispatch({ kind: 'RESET_CONVERSATION' })
    dispatch({ kind: 'SET_CLIENT_ID', clientId: next })
    // Upgrade-time `_agimUserId` is sticky. Re-handshake so the new
    // account's cookie pins cwd to `users/<usr_*>/<agent>/`.
    if (typeof wsRef.current.reconnect === 'function') {
      wsRef.current.reconnect()
    } else {
      wsRef.current.send({ type: 'get-history', threadId: next })
    }
    void pullRemoteRef.current()
  }, [
    authReady,
    signedIn,
    accountUserId,
    threadIdRef,
    currentReplyIdRef,
    dispatch,
    wsRef,
    pullRemoteRef,
  ])
}
