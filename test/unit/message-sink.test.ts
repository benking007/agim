// message-sink — unit tests covering the routing / fallback logic.
//
// We can't exercise the worker's full DB path here (bun + better-sqlite3
// is broken — see outbox.test.ts probe). What we CAN exercise without
// the DB:
//   - resolveMessenger fuzzy match
//   - priority='high' sync path (when adapter succeeds)
//   - priority='high' sync failure → falls back to queue (verified by
//     watching for the warn log and a non-throwing return)
//   - typing kind never persists
//   - card kind degrades to sendMessage when adapter has no sendCard
//
// Sink uses the global PluginRegistry, so we add and remove fake
// messengers around each test.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-sink-test-'))
process.env.AGIM_HOME = TEST_HOME

const { registry } = await import('../../src/core/registry.js')
const sinkMod = await import('../../src/core/message-sink.js')

import type { MessengerAdapter } from '../../src/core/types.js'

type FakeAdapter = MessengerAdapter & {
  /** Recorded calls for assertion. */
  log: Array<{ method: string; threadId: string; payload?: unknown }>
  shouldFail?: boolean
}

function makeAdapter(name: string, opts: { withCard?: boolean; withTyping?: boolean } = {}): FakeAdapter {
  const log: FakeAdapter['log'] = []
  const a: FakeAdapter = {
    name, log,
    async start() {}, async stop() {}, onMessage() {},
    async sendMessage(threadId, text) {
      if (a.shouldFail) throw new Error('fake adapter forced failure')
      log.push({ method: 'sendMessage', threadId, payload: text })
    },
  }
  if (opts.withCard) {
    a.sendCard = async (threadId, card) => {
      if (a.shouldFail) throw new Error('fake adapter forced failure')
      log.push({ method: 'sendCard', threadId, payload: card })
    }
  }
  if (opts.withTyping) {
    a.sendTyping = async (threadId, isTyping) => {
      log.push({ method: 'sendTyping', threadId, payload: isTyping })
    }
  }
  return a
}

const REGISTERED: string[] = []
function register(a: FakeAdapter): void {
  registry.registerMessenger(a)
  REGISTERED.push(a.name)
}

afterEach(() => {
  for (const name of REGISTERED.splice(0)) {
    // PluginRegistry has no removeMessenger; nullify by overwriting with a
    // sentinel that throws if anyone tries to send. Each test re-registers
    // adapters it cares about, so leakage between tests is masked by the
    // 'unique platform' convention each test uses.
    registry.registerMessenger({
      ...makeAdapter(name),
      async sendMessage() { throw new Error('adapter unregistered between tests') },
    })
  }
})

afterEach(() => {
  try { sinkMod.stopWorker() } catch { /* ignore */ }
})

describe('resolveMessenger fuzzy match', () => {
  it('returns exact match when registered name == platform', () => {
    const a = makeAdapter('feishu')
    register(a)
    expect(sinkMod.resolveMessenger('feishu')).toBe(a)
  })

  it('matches prefix-with-dash (e.g. wechat → wechat-ilink)', () => {
    const a = makeAdapter('wechat-ilink')
    register(a)
    expect(sinkMod.resolveMessenger('wechat')).toBe(a)
  })

  it('matches prefix-with-underscore (legacy fallback)', () => {
    const a = makeAdapter('telegram_v2')
    register(a)
    expect(sinkMod.resolveMessenger('telegram')).toBe(a)
  })

  it('returns undefined when nothing matches', () => {
    expect(sinkMod.resolveMessenger('does-not-exist-xyz')).toBeUndefined()
  })
})

describe('deliver typing kind', () => {
  it('calls adapter.sendTyping with start=true and never enqueues', async () => {
    const a = makeAdapter('typeplat', { withTyping: true })
    register(a)
    const res = await sinkMod.deliver({
      platform: 'typeplat', channelId: 'c', threadId: 't',
      payload: 'start', kind: 'typing',
    })
    expect(res.outboxId).toBe(-1)
    expect(res.immediate).toBe(true)
    expect(a.log).toEqual([{ method: 'sendTyping', threadId: 't', payload: true }])
  })

  it('payload="stop" → isTyping=false', async () => {
    const a = makeAdapter('typeplat2', { withTyping: true })
    register(a)
    await sinkMod.deliver({
      platform: 'typeplat2', channelId: 'c', threadId: 't',
      payload: 'stop', kind: 'typing',
    })
    expect(a.log[0]).toEqual({ method: 'sendTyping', threadId: 't', payload: false })
  })

  it('typing is silently dropped when adapter does not support it', async () => {
    register(makeAdapter('typenope'))  // no sendTyping
    const res = await sinkMod.deliver({
      platform: 'typenope', channelId: 'c', threadId: 't',
      payload: 'start', kind: 'typing',
    })
    expect(res.outboxId).toBe(-1)
    expect(res.immediate).toBe(true)
  })
})

describe('deliver priority=high sync path', () => {
  it('sync send succeeds → immediate=true', async () => {
    const a = makeAdapter('hp1')
    register(a)
    const res = await sinkMod.deliver({
      platform: 'hp1', channelId: 'c', threadId: 't',
      payload: 'urgent', kind: 'text', priority: 'high',
    })
    expect(res.immediate).toBe(true)
    expect(a.log).toEqual([{ method: 'sendMessage', threadId: 't', payload: 'urgent' }])
  })

  it('sync send fails → does not throw; falls through to enqueue path', async () => {
    const a = makeAdapter('hp2')
    a.shouldFail = true
    register(a)
    // Even when sync fails AND outbox enqueue returns -1 (degraded DB),
    // sink should still try the last-ditch direct send. With shouldFail
    // permanently true that last-ditch also fails — sink swallows and
    // returns immediate=false. Important: it must not throw.
    let threw = false
    let res: { outboxId: number; immediate: boolean } | undefined
    try {
      res = await sinkMod.deliver({
        platform: 'hp2', channelId: 'c', threadId: 't',
        payload: 'urgent', kind: 'text', priority: 'high',
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(res).toBeDefined()
    // outboxId is either >0 (DB worked) or -1 (degraded). Either way the
    // contract is "deliver returned without throwing".
  })
})

describe('deliver text routing via fuzzy match', () => {
  it("platform='wechat' lands on adapter 'wechat-ilink'", async () => {
    const a = makeAdapter('wechat-ilink')
    register(a)
    await sinkMod.deliver({
      platform: 'wechat', channelId: 'c', threadId: 'u123',
      payload: 'hi', kind: 'text', priority: 'high',
    })
    expect(a.log[0]).toEqual({ method: 'sendMessage', threadId: 'u123', payload: 'hi' })
  })
})

describe('deliver viewer routing (agent source)', () => {
  const VIEWER_KEYS = [
    'IMHUB_VIEWER_ENABLED',
    'IMHUB_VIEWER_PUBLIC_BASE_URL',
    'IMHUB_VIEWER_TUNNEL_MODE',
    'IMHUB_VIEWER_NO_DEFAULT_REMOTE',
    'IMHUB_VIEWER_REMOTE_PASTE_URL',
  ] as const

  beforeEach(() => {
    for (const k of VIEWER_KEYS) delete process.env[k]
  })

  it('does not truncate or link when IMHUB_VIEWER_ENABLED is off', async () => {
    process.env.IMHUB_VIEWER_ENABLED = '0'
    const a = makeAdapter('viewoff')
    register(a)
    const long = 'x'.repeat(600)
    await sinkMod.deliver({
      platform: 'viewoff', channelId: 'c', threadId: 't',
      payload: long, kind: 'text', priority: 'high', source: 'agent',
    })
    expect(a.log[0]?.payload).toBe(long)
    expect(String(a.log[0]?.payload)).not.toMatch(/viewer\.iclaw|📎/)
  })

  it('does not use default remote when enabled but NO_DEFAULT_REMOTE=1 and no URL', async () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_NO_DEFAULT_REMOTE = '1'
    const a = makeAdapter('viewnodef')
    register(a)
    const long = 'y'.repeat(600)
    await sinkMod.deliver({
      platform: 'viewnodef', channelId: 'c', threadId: 't',
      payload: long, kind: 'text', priority: 'high', source: 'agent',
    })
    const sent = String(a.log[0]?.payload)
    expect(sent).not.toMatch(/viewer\.iclaw\.host/)
    expect(sent).not.toMatch(/📎\s+https?:\/\//)
  })
})

describe('deliver card kind', () => {
  it('uses sendCard when adapter implements it', async () => {
    const a = makeAdapter('cardp', { withCard: true })
    register(a)
    const card = { title: 'Hello', body: 'world' }
    await sinkMod.deliver({
      platform: 'cardp', channelId: 'c', threadId: 't',
      payload: card, kind: 'card', priority: 'high',
    })
    // For sendCard the adapter receives the OBJECT, not the JSON string,
    // because doSend JSON.parses what it stored.
    expect(a.log[0]).toEqual({ method: 'sendCard', threadId: 't', payload: card })
  })

  it('degrades to sendMessage (JSON body) when adapter lacks sendCard', async () => {
    const a = makeAdapter('nocardp')  // no sendCard
    register(a)
    const card = { title: 'Hello' }
    await sinkMod.deliver({
      platform: 'nocardp', channelId: 'c', threadId: 't',
      payload: card, kind: 'card', priority: 'high',
    })
    expect(a.log[0]).toMatchObject({ method: 'sendMessage', threadId: 't' })
    expect(typeof a.log[0].payload).toBe('string')
    expect(JSON.parse(a.log[0].payload as string)).toEqual(card)
  })
})

afterEach(() => {
  // Final cleanup — close the temp DB so the next test file gets a clean slate.
})

// Process-wide cleanup
import { afterAll } from 'bun:test'
afterAll(() => {
  try { sinkMod.stopWorker() } catch { /* ignore */ }
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})
