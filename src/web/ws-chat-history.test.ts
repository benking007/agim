import { afterEach, describe, expect, it } from 'bun:test'
import type { WebSocket } from 'ws'
import { sessionManager } from '../core/session.js'
import { handleClientMessage } from './ws-chat.js'

function fakeWs(): { ws: WebSocket; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>) },
  } as unknown as WebSocket
  return { ws, sent }
}

function historyTexts(sent: Record<string, unknown>[]): string[] {
  const texts: string[] = []
  for (const frame of sent) {
    if (frame.type !== 'history' && frame.type !== 'history-prepend') continue
    const messages = Array.isArray(frame.messages) ? frame.messages : []
    for (const row of messages) {
      if (row && typeof row === 'object' && typeof (row as { content?: unknown }).content === 'string') {
        texts.push((row as { content: string }).content)
      }
    }
  }
  return texts
}

describe('handleClientMessage get-history ownership', () => {
  afterEach(() => {
    // sessions persist on disk under AGIM_HOME; unique thread ids avoid collisions
  })

  it('refuses a disk-owned thread after process restart (empty memory owners)', async () => {
    const owned = `web-own${Date.now().toString(36)}aa`
    const fresh = `web-new${Date.now().toString(36)}bb`
    await sessionManager.getOrCreateSession('web', 'web', owned, 'agim')
    expect(await sessionManager.claimWebSessionOwner(owned, 'usr_aaaaaa')).toBe(true)
    await sessionManager.addMessage('web', 'web', owned, {
      role: 'user',
      content: 'secret-from-A',
      timestamp: new Date(),
    })

    const { ws, sent } = fakeWs()
    const threadOwners = new Map<string, string>()
    await handleClientMessage(
      { ws, id: fresh, agent: 'agim' },
      { type: 'get-history', threadId: owned },
      'agim',
      undefined,
      'token-b',
      threadOwners,
      undefined,
      'usr_bbbbbb',
    )

    expect(sent.some((m) => m.type === 'thread-reassigned' && m.threadId === fresh)).toBe(true)
    expect(historyTexts(sent)).not.toContain('secret-from-A')
    expect(threadOwners.get(owned)).toBeUndefined()
  })

  it('lets the same account resume a disk-owned thread with empty memory owners', async () => {
    const owned = `web-sam${Date.now().toString(36)}aa`
    const fresh = `web-new${Date.now().toString(36)}cc`
    await sessionManager.getOrCreateSession('web', 'web', owned, 'agim')
    expect(await sessionManager.claimWebSessionOwner(owned, 'usr_cccccc')).toBe(true)
    await sessionManager.addMessage('web', 'web', owned, {
      role: 'user',
      content: 'alice-transcript',
      timestamp: new Date(),
    })

    const { ws, sent } = fakeWs()
    const threadOwners = new Map<string, string>()
    await handleClientMessage(
      { ws, id: fresh, agent: 'agim' },
      { type: 'get-history', threadId: owned },
      'agim',
      undefined,
      'token-c',
      threadOwners,
      undefined,
      'usr_cccccc',
    )

    expect(sent.some((m) => m.type === 'thread-reassigned')).toBe(false)
    expect(historyTexts(sent)).toContain('alice-transcript')
    expect(threadOwners.get(owned)).toBe('usr_cccccc')
  })

  it('does not send foreign history when claimWebSessionOwner loses the race', async () => {
    const owned = `web-rce${Date.now().toString(36)}aa`
    const fresh = `web-new${Date.now().toString(36)}dd`
    await sessionManager.getOrCreateSession('web', 'web', owned, 'agim')
    expect(await sessionManager.claimWebSessionOwner(owned, 'usr_dddddd')).toBe(true)
    await sessionManager.addMessage('web', 'web', owned, {
      role: 'user',
      content: 'still-secret',
      timestamp: new Date(),
    })

    const { ws, sent } = fakeWs()
    await handleClientMessage(
      { ws, id: fresh, agent: 'agim' },
      { type: 'get-history', threadId: owned },
      'agim',
      undefined,
      'token-e',
      new Map([[owned, 'token-e']]),
      undefined,
      'usr_eeeeee',
    )

    expect(sent.some((m) => m.type === 'thread-reassigned' && m.threadId === fresh)).toBe(true)
    expect(historyTexts(sent)).not.toContain('still-secret')
  })
})
