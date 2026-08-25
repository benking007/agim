import { afterEach, describe, expect, it } from 'bun:test'
import type { WebSocket } from 'ws'
import { sessionManager } from '../core/session.js'
import { _resetTurnSteer, registerLiveSteer } from '../core/turn-steer.js'
import { handleClientMessage, webRunAborts, bindWsClients, notifyAccountSessionsChanged } from './ws-chat.js'

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
  _resetTurnSteer()
  webRunAborts.clear()
})

describe('handleClientMessage steer', () => {
  it('injects into the live harness and persists a user message', async () => {
    const threadId = `web-steer-${Date.now()}`
    await sessionManager.getOrCreateSession('web', 'web', threadId, 'agim')
    webRunAborts.set(threadId, new AbortController())
    const seen: string[] = []
    const unreg = registerLiveSteer(`web:web:${threadId}`, async (text) => {
      seen.push(text)
    })
    const { ws, sent } = fakeWs()
    await handleClientMessage(
      { ws, id: threadId, agent: 'agim' },
      { type: 'steer', text: 'also run the tests' },
      'agim',
    )
    unreg()
    expect(seen).toEqual(['also run the tests'])
    expect(sent.some((m) => m.type === 'steer-accepted' && m.mode === 'live')).toBe(true)
    const hist = await sessionManager.getSessionWithHistory('web', 'web', threadId)
    expect(hist?.messages.some((m) => m.role === 'user' && m.content === 'also run the tests')).toBe(true)
  })

  it('rejects steer when no run is in flight', async () => {
    const { ws, sent } = fakeWs()
    await handleClientMessage(
      { ws, id: 'web-idle', agent: 'agim' },
      { type: 'steer', text: 'nope' },
      'agim',
    )
    expect(sent.some((m) => m.type === 'error')).toBe(true)
  })

  it('rejects steer for a non-Agim agent', async () => {
    const threadId = `web-cli-${Date.now()}`
    webRunAborts.set(threadId, new AbortController())
    const { ws, sent } = fakeWs()
    await handleClientMessage(
      { ws, id: threadId, agent: 'claude-code' },
      { type: 'steer', text: 'later' },
      'claude-code',
    )
    expect(sent.some((m) => (
      m.type === 'error' && String(m.message).includes('不支持本轮补充')
    ))).toBe(true)
  })
})

describe('notifyAccountSessionsChanged', () => {
  it('fans out sessions-changed to the same account only', () => {
    const a = fakeWs()
    const b = fakeWs()
    const c = fakeWs()
    const clients = new Map([
      ['web-a', { ws: a.ws, id: 'web-a', agent: 'agim', userId: 'u1' }],
      ['web-b', { ws: b.ws, id: 'web-b', agent: 'agim', userId: 'u1' }],
      ['web-c', { ws: c.ws, id: 'web-c', agent: 'agim', userId: 'u2' }],
    ])
    bindWsClients(clients)
    try {
      notifyAccountSessionsChanged('u1')
      expect(a.sent).toEqual([{ type: 'sessions-changed' }])
      expect(b.sent).toEqual([{ type: 'sessions-changed' }])
      expect(c.sent).toEqual([])
    } finally {
      bindWsClients(new Map())
    }
  })
})
