/**
 * In-memory chat islands: one ChatState per web-* thread so Portal can
 * switch without RESET_CONVERSATION wiping a live run.
 *
 * The visible reducer still holds the active island. Background WS frames
 * are applied here; activateThread restores the bag into the reducer.
 */

import { chatReducer, initialChatState } from './chat-reducer'
import type { ChatAction } from './chat-reducer'
import type { ChatState } from './chat-types'
import { isWebThreadId } from '@/lib/web-sessions'

export const MAX_CHAT_ISLANDS = 16

export interface ChatIslandBag {
  state: ChatState
}

const islands = new Map<string, ChatIslandBag>()
const lru: string[] = []

export function chatIslandBusy(state: ChatState): boolean {
  return state.currentReplyId != null || state.activeRunId != null
    || state.pendingAsks.some((a) => !a.finalText)
    || state.pendingApprovals.some((a) => !a.outcome)
}

function touch(threadId: string): void {
  const i = lru.indexOf(threadId)
  if (i >= 0) lru.splice(i, 1)
  lru.unshift(threadId)
}

function evictIdle(): void {
  while (islands.size > MAX_CHAT_ISLANDS) {
    const victim = [...lru].reverse().find((id) => {
      const bag = islands.get(id)
      return bag && !chatIslandBusy(bag.state)
    })
    if (!victim) break
    islands.delete(victim)
    const idx = lru.indexOf(victim)
    if (idx >= 0) lru.splice(idx, 1)
  }
}

export function seedChatIsland(threadId: string, state?: ChatState): ChatIslandBag {
  const id = threadId.trim()
  const bag: ChatIslandBag = {
    state: {
      ...(state ?? initialChatState),
      clientId: id,
      historyLoading: state ? false : true,
    },
  }
  islands.set(id, bag)
  touch(id)
  evictIdle()
  return bag
}

export function putChatIsland(threadId: string, state: ChatState): ChatIslandBag {
  const id = threadId.trim()
  if (!id || !isWebThreadId(id)) return { state }
  const bag: ChatIslandBag = { state: { ...state, clientId: id } }
  islands.set(id, bag)
  touch(id)
  evictIdle()
  return bag
}

export function getChatIsland(threadId: string): ChatIslandBag | undefined {
  const id = threadId.trim()
  if (!id) return undefined
  const bag = islands.get(id)
  if (bag) touch(id)
  return bag
}

export function applyChatActionToIsland(threadId: string, action: ChatAction): ChatState {
  const id = threadId.trim()
  const prev = islands.get(id)?.state ?? {
    ...initialChatState,
    clientId: id,
    historyLoading: false,
  }
  const next = chatReducer(prev, action)
  islands.set(id, { state: next })
  touch(id)
  return next
}

export function busyChatThreadIds(): string[] {
  const out: string[] = []
  for (const [id, bag] of islands) {
    if (chatIslandBusy(bag.state)) out.push(id)
  }
  return out
}

export function clearChatIslands(): void {
  islands.clear()
  lru.length = 0
}
