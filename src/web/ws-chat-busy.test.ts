import { afterEach, describe, expect, it } from 'bun:test'
import type { WebSocket } from 'ws'
import { sessionManager } from '../core/session.js'
import {
  handleClientMessage,
  webRunAborts,
  USER_INTERRUPTED_TEXT,
  rekeyWebRunState,
  _resetHeldWebMessagesForTests,
  _peekHeldWebMessagesForTests,
} from './ws-chat.js'

function fakeWs(): { ws: WebSocket; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>) },
  } as unknown as WebSocket
  return { ws, sent }
}

afterEach(() => {
  webRunAborts.clear()
  _resetHeldWebMessagesForTests()
})

describe('in-flight web message does not replace the live job', () => {
  it('holds a different follow-up instead of aborting', async () => {
    const threadId = `web-busy-${Date.now().toString(36)}`
    await sessionManager.getOrCreateSession('web', 'web', threadId, 'agim')
    await sessionManager.addMessage('web', 'web', threadId, {
      role: 'user', content: 'first prompt', timestamp: new Date(),
    })
    const live = new AbortController()
    webRunAborts.set(threadId, live)
    const { ws, sent } = fakeWs()
    await handleClientMessage(
      { ws, id: threadId, agent: 'agim' },
      { type: 'message', text: 'please also check logs' },
      'agim',
    )
    expect(live.signal.aborted).toBe(false)
    expect(webRunAborts.get(threadId)).toBe(live)
    expect(_peekHeldWebMessagesForTests(threadId)).toEqual(['please also check logs'])
    expect(sent.some((m) => m.type === 'message-held')).toBe(true)
    const hist = await sessionManager.getSessionWithHistory('web', 'web', threadId)
    expect(hist?.messages.some((m) => m.content === USER_INTERRUPTED_TEXT)).toBe(false)
  })

  it('ignores an exact duplicate of the last user prompt', async () => {
    const threadId = `web-dup-${Date.now().toString(36)}`
    await sessionManager.getOrCreateSession('web', 'web', threadId, 'agim')
    await sessionManager.addMessage('web', 'web', threadId, {
      role: 'user', content: 'research the outage', timestamp: new Date(),
    })
    const live = new AbortController()
    webRunAborts.set(threadId, live)
    const { ws, sent } = fakeWs()
    await handleClientMessage(
      { ws, id: threadId, agent: 'agim' },
      { type: 'message', text: 'research the outage' },
      'agim',
    )
    expect(live.signal.aborted).toBe(false)
    expect(_peekHeldWebMessagesForTests(threadId)).toEqual([])
    expect(sent.some((m) => m.type === 'message-accepted')).toBe(true)
    expect(sent.some((m) => m.type === 'run-start')).toBe(false)
  })

  it('rekeyWebRunState moves the abort controller to the persisted id', () => {
    const ac = new AbortController()
    webRunAborts.set('web-old', ac)
    rekeyWebRunState('web-old', 'web-new')
    expect(webRunAborts.get('web-old')).toBeUndefined()
    expect(webRunAborts.get('web-new')).toBe(ac)
    expect(ac.signal.aborted).toBe(false)
  })
})
