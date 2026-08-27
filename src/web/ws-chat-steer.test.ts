import { afterEach, describe, expect, it } from 'bun:test'
import type { WebSocket } from 'ws'
import { sessionManager } from '../core/session.js'
import { startLoop, getActiveLoop } from '../core/loop-run.js'
import { setFocus } from '../core/focus.js'
import { _resetTurnSteer, registerLiveSteer } from '../core/turn-steer.js'
import { handlePlanCommand } from '../core/commands/plan.js'
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

  it('records 打断发送 on an active Loop so the snippet sees it', async () => {
    const threadId = `web-loop-steer-${Date.now()}`
    setFocus({ platform: 'web', channelId: 'web', threadId, userId: 'u1', title: 'loop' })
    const started = startLoop({
      platform: 'web',
      channelId: 'web',
      threadId,
      userId: 'u1',
      text: '修好超时；退出条件为最多3轮',
    })
    if (!started.ok) return
    await sessionManager.getOrCreateSession('web', 'web', threadId, 'agim')
    webRunAborts.set(threadId, new AbortController())
    const unreg = registerLiveSteer(`web:web:${threadId}`, async () => {})
    const { ws } = fakeWs()
    await handleClientMessage(
      { ws, id: threadId, agent: 'agim' },
      { type: 'steer', text: '停，改查 nginx' },
      'agim',
    )
    unreg()
    const run = getActiveLoop('web', 'web', threadId)
    expect(run?.userSteers?.some((s) => s.text.includes('nginx'))).toBe(true)
  })

  it('treats /plan off as a command, not a mid-turn supplement', async () => {
    const threadId = `web-plan-off-${Date.now()}`
    await handlePlanCommand('on', {
      threadId,
      channelId: 'web',
      platform: 'web',
      defaultAgent: 'agim',
      traceId: 't',
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } } as never,
    })
    webRunAborts.set(threadId, new AbortController())
    const seen: string[] = []
    const unreg = registerLiveSteer(`web:web:${threadId}`, async (text) => {
      seen.push(text)
    })
    const { ws, sent } = fakeWs()
    await handleClientMessage(
      { ws, id: threadId, agent: 'agim' },
      { type: 'steer', text: '/plan off' },
      'agim',
    )
    unreg()
    expect(seen).toEqual([])
    expect(sent.some((m) => m.type === 'steer-accepted')).toBe(true)
    expect(sent.some((m) => m.type === 'plan-mode' && m.enabled === false)).toBe(true)
    expect(sent.every((m) => !String(m.text ?? '').includes('本轮补充'))).toBe(true)
    const hist = await sessionManager.getSessionWithHistory('web', 'web', threadId)
    expect(hist?.messages.some((m) => m.role === 'user' && m.content === '/plan off')).toBe(true)
    expect(hist?.messages.some((m) => m.role === 'assistant' && String(m.content).includes('已关闭'))).toBe(true)
    expect(hist?.session.planMode).toBeUndefined()
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
