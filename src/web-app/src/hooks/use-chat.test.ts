/**
 * chatReducer — unit tests for the reducer at the heart of /chat.
 *
 * The reducer is a pure function `(state, action) → state` and
 * covers a non-trivial state machine: WS lifecycle, optimistic
 * send, streaming chunk accumulation, server-final reconciliation,
 * inline approval cards. Indirect coverage via the route smoke
 * tests is real, but a unit pass against the dispatch surface
 * catches regressions in the transitions themselves (the place
 * where the bug lives, not in the render layer).
 */

import { describe, expect, it } from 'vitest'
import {
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatMessage,
  type ChatState,
} from './use-chat'

function userMsg(id: string, content = ''): ChatMessage {
  return { id, role: 'user', content, timestamp: 0 }
}
function asstMsg(id: string, content = ''): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 0 }
}

function reduce(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state)
}

describe('chatReducer', () => {
  it('WS_STATUS replaces the status field only', () => {
    const s = reduce(initialChatState, { kind: 'WS_STATUS', status: 'open' })
    expect(s.status).toBe('open')
    expect(s.messages).toEqual([])
    expect(s.agents).toEqual([])
  })

  it('INIT sets agents + defaultAgent; preserves a user-chosen agent', () => {
    const s1 = reduce(initialChatState, { kind: 'INIT', agents: ['a', 'b'], defaultAgent: 'a' })
    expect(s1).toMatchObject({ agents: ['a', 'b'], agent: 'a' })
    // If the user already picked 'b' before INIT lands, INIT does NOT
    // overwrite — defaultAgent is the fallback, not the override.
    const s2 = reduce(
      { ...initialChatState, agent: 'b' },
      { kind: 'INIT', agents: ['a', 'b'], defaultAgent: 'a' },
    )
    expect(s2.agent).toBe('b')
  })

  it('HISTORY replaces messages + sets agent', () => {
    const hist = [userMsg('h-1', 'hi'), asstMsg('h-2', 'hello')]
    const s = reduce(initialChatState, { kind: 'HISTORY', messages: hist, agent: 'claude' })
    expect(s.messages).toBe(hist)
    expect(s.agent).toBe('claude')
  })

  it('SEND_USER appends user message + placeholder + sets currentReplyId + clears error', () => {
    const u = userMsg('u-1', 'hi')
    const p = asstMsg('p-1')
    const s = reduce(
      { ...initialChatState, error: 'previous failure' },
      { kind: 'SEND_USER', message: u, placeholder: p },
    )
    expect(s.messages).toEqual([u, p])
    expect(s.currentReplyId).toBe('p-1')
    expect(s.error).toBeNull()
  })

  it('CHUNK appends to the matching message; ignored if replyId absent', () => {
    const base = reduce(initialChatState, {
      kind: 'SEND_USER', message: userMsg('u-1', 'hi'), placeholder: asstMsg('p-1'),
    })
    const afterChunk = reduce(base,
      { kind: 'CHUNK', replyId: 'p-1', text: 'Hel' },
      { kind: 'CHUNK', replyId: 'p-1', text: 'lo' },
    )
    expect(afterChunk.messages[1]?.content).toBe('Hello')
    // CHUNK for an unknown reply does not mutate.
    const ignored = reduce(afterChunk, { kind: 'CHUNK', replyId: 'nope', text: '!' })
    expect(ignored).toBe(afterChunk)
  })

  it('DONE prefers the server-final text + clears currentReplyId', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1', 'hi'), placeholder: asstMsg('p-1') },
      { kind: 'CHUNK', replyId: 'p-1', text: 'partial' },
      { kind: 'DONE', replyId: 'p-1', finalText: 'Hello, full text.' },
    )
    expect(after.messages[1]?.content).toBe('Hello, full text.')
    expect(after.currentReplyId).toBeNull()
  })

  it('DONE with empty finalText keeps accumulated chunks', () => {
    const after = reduce(
      initialChatState,
      { kind: 'SEND_USER', message: userMsg('u-1'), placeholder: asstMsg('p-1') },
      { kind: 'CHUNK', replyId: 'p-1', text: 'partial' },
      { kind: 'DONE', replyId: 'p-1', finalText: '' },
    )
    expect(after.messages[1]?.content).toBe('partial')
    expect(after.currentReplyId).toBeNull()
  })

  it('DONE for an unknown id only clears currentReplyId', () => {
    const after = reduce(
      { ...initialChatState, currentReplyId: 'p-1' },
      { kind: 'DONE', replyId: 'never-existed', finalText: 'x' },
    )
    expect(after.currentReplyId).toBeNull()
    expect(after.messages).toEqual([])
  })

  it('ERROR records the message + clears currentReplyId', () => {
    const after = reduce(
      { ...initialChatState, currentReplyId: 'p-1' },
      { kind: 'ERROR', message: 'WS closed' },
    )
    expect(after.error).toBe('WS closed')
    expect(after.currentReplyId).toBeNull()
  })

  it('CLEAR_ERROR resets only the error field', () => {
    const after = reduce(
      { ...initialChatState, error: 'oops', agents: ['a'] },
      { kind: 'CLEAR_ERROR' },
    )
    expect(after.error).toBeNull()
    expect(after.agents).toEqual(['a'])
  })

  it('AGENTS replaces the agent list; AGENT_SWITCHED replaces the selected agent', () => {
    const s1 = reduce(initialChatState,
      { kind: 'AGENTS', agents: ['claude', 'codex'] },
      { kind: 'AGENT_SWITCHED', agent: 'codex' },
    )
    expect(s1).toMatchObject({ agents: ['claude', 'codex'], agent: 'codex' })
  })

  it('APPROVAL_CARD appends a system message with the approval payload', () => {
    const after = reduce(
      initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'msg-7', prompt: 'run rm -rf?' },
    )
    expect(after.messages).toHaveLength(1)
    const m = after.messages[0]!
    expect(m.role).toBe('system')
    expect(m.approval).toMatchObject({ messageId: 'msg-7', prompt: 'run rm -rf?' })
    expect(m.approval?.outcome).toBeUndefined()
  })

  it('APPROVAL_EDIT updates the outcome on the matching approval card', () => {
    const card = reduce(initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'msg-7', prompt: 'p' },
      { kind: 'APPROVAL_EDIT', messageId: 'msg-7', outcome: 'allow' },
    )
    expect(card.messages[0]?.approval?.outcome).toBe('allow')
  })

  it('APPROVAL_EDIT for an unknown messageId is a no-op', () => {
    const before = reduce(initialChatState,
      { kind: 'APPROVAL_CARD', messageId: 'msg-7', prompt: 'p' },
    )
    const after = reduce(before, { kind: 'APPROVAL_EDIT', messageId: 'never', outcome: 'deny' })
    expect(after).toBe(before)
  })

  it('a full happy-path session: connect → init → send → stream → done', () => {
    const sess = reduce(initialChatState,
      { kind: 'WS_STATUS', status: 'connecting' },
      { kind: 'WS_STATUS', status: 'open' },
      { kind: 'INIT', agents: ['claude'], defaultAgent: 'claude' },
      { kind: 'SEND_USER', message: userMsg('u-1', 'hello'), placeholder: asstMsg('p-1') },
      { kind: 'CHUNK', replyId: 'p-1', text: 'Hi ' },
      { kind: 'CHUNK', replyId: 'p-1', text: 'there!' },
      { kind: 'DONE', replyId: 'p-1', finalText: 'Hi there!' },
    )
    expect(sess.status).toBe('open')
    expect(sess.agent).toBe('claude')
    expect(sess.currentReplyId).toBeNull()
    expect(sess.messages.map((m) => m.content)).toEqual(['hello', 'Hi there!'])
  })
})
