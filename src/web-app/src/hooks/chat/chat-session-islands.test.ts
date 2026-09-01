import { beforeEach, describe, expect, it } from 'vitest'

import { chatReducer, initialChatState } from './chat-reducer'
import {
  applyChatActionToIsland,
  busyChatThreadIds,
  chatIslandBusy,
  clearChatIslands,
  getChatIsland,
  putChatIsland,
} from './chat-session-islands'
import type { ChatState } from './chat-types'

const A = 'web-aaaa1111'
const B = 'web-bbbb2222'

function bag(over: Partial<ChatState> = {}): ChatState {
  return { ...initialChatState, historyLoading: false, ...over }
}

describe('chat session islands', () => {
  beforeEach(() => {
    clearChatIslands()
  })

  it('keeps transcripts isolated per thread', () => {
    putChatIsland(A, bag({
      messages: [{ id: 'u1', role: 'user', content: '给 A', timestamp: 1 }],
    }))
    putChatIsland(B, bag({
      messages: [{ id: 'u2', role: 'user', content: '给 B', timestamp: 2 }],
    }))
    expect(getChatIsland(A)?.state.messages[0]?.content).toBe('给 A')
    expect(getChatIsland(B)?.state.messages[0]?.content).toBe('给 B')
  })

  it('applies a background CHUNK only to that island', () => {
    putChatIsland(A, bag({
      currentReplyId: 'a1',
      messages: [
        { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '', timestamp: 2 },
      ],
    }))
    putChatIsland(B, bag({
      messages: [{ id: 'u2', role: 'user', content: 'other', timestamp: 3 }],
    }))
    applyChatActionToIsland(A, { kind: 'CHUNK', replyId: 'a1', text: '后台流式' })
    expect(getChatIsland(A)?.state.messages[1]?.content).toBe('后台流式')
    expect(getChatIsland(B)?.state.messages[0]?.content).toBe('other')
    expect(getChatIsland(B)?.state.messages).toHaveLength(1)
  })

  it('RESTORE_ISLAND keeps the live WS status and agent list', () => {
    const island = bag({
      clientId: A,
      status: 'closed',
      agents: [],
      currentReplyId: 'a1',
      messages: [{ id: 'a1', role: 'assistant', content: '…', timestamp: 1 }],
    })
    const live = bag({
      status: 'open',
      agents: ['agim', 'claude-code'],
      historyLoading: true,
    })
    const next = chatReducer(live, { kind: 'RESTORE_ISLAND', state: island })
    expect(next.status).toBe('open')
    expect(next.agents).toEqual(['agim', 'claude-code'])
    expect(next.historyLoading).toBe(false)
    expect(next.currentReplyId).toBe('a1')
    expect(next.messages[0]?.content).toBe('…')
  })

  it('does not evict a busy island when the cap is exceeded', () => {
    putChatIsland(A, bag({ currentReplyId: 'live-a' }))
    for (let i = 0; i < 16; i++) {
      const id = `web-idle${String(i).padStart(4, '0')}`
      putChatIsland(id, bag({ clientId: id }))
    }
    expect(getChatIsland(A)?.state.currentReplyId).toBe('live-a')
    expect(chatIslandBusy(getChatIsland(A)!.state)).toBe(true)
    expect(busyChatThreadIds()).toContain(A)
  })

  it('treats a pending ask as busy', () => {
    const state = bag({
      pendingAsks: [{
        messageId: 'ask-1',
        prompt: { body: 'Which?', choices: [{ label: '1. a', data: 'ask:1:1' }] },
      }],
    })
    expect(chatIslandBusy(state)).toBe(true)
  })
})
