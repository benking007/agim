// Unit tests for ask-user-rpc.
//
// We stub the messenger registry by injecting a fake adapter that
// records sendChoiceCard / sendMessage calls. Tests cover the four
// resolution paths (text, button, timeout, unknown), input validation,
// and the matchTextToChoice heuristic.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  handleAskOp,
  tryResolvePendingAsk,
  tryResolvePendingAskByButton,
  listPendingAsks,
  _resetAskBusForTests,
  type AskResult,
} from './ask-user-rpc.js'
import { registry } from './registry.js'
import type { MessengerAdapter, ChoiceCardPrompt } from './types.js'

interface FakeMessenger extends MessengerAdapter {
  cards: Array<{ threadId: string; prompt: ChoiceCardPrompt }>
  texts: Array<{ threadId: string; text: string }>
}

function makeFakeMessenger(name: string, opts: { withCards: boolean } = { withCards: true }): FakeMessenger {
  const cards: FakeMessenger['cards'] = []
  const texts: FakeMessenger['texts'] = []
  const base = {
    name,
    cards,
    texts,
    async start() { /* noop */ },
    async stop() { /* noop */ },
    onMessage(_: (ctx: unknown) => Promise<void>) { /* noop */ },
    async sendMessage(threadId: string, text: string) { texts.push({ threadId, text }) },
  } as unknown as FakeMessenger
  if (opts.withCards) {
    (base as MessengerAdapter).sendChoiceCard = async (threadId: string, prompt: ChoiceCardPrompt) => {
      cards.push({ threadId, prompt })
      return { messageId: `m-${cards.length}` }
    }
  }
  return base
}

const CTX = {
  platform: 'fake',
  channelId: 'c1',
  threadId: 't1',
  userId: 'u1',
}

const REGISTERED_MESSENGERS: string[] = []

function register(m: FakeMessenger): void {
  registry.registerMessenger(m)
  REGISTERED_MESSENGERS.push(m.name)
}

beforeEach(() => {
  _resetAskBusForTests()
})

afterEach(() => {
  _resetAskBusForTests()
  // The registry has no unregister API; we just leave stale fake
  // messengers across tests (each test re-registers under a fresh
  // platform name to avoid cross-test interference).
})

describe('handleAskOp — validation', () => {
  it('rejects missing question', async () => {
    register(makeFakeMessenger('v-empty-q'))
    const r = await handleAskOp(
      { choices: ['a', 'b'] },
      { ...CTX, platform: 'v-empty-q' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid')
  })

  it('rejects too few / too many choices', async () => {
    register(makeFakeMessenger('v-too-few'))
    let r = await handleAskOp(
      { question: 'q?', choices: ['only one'] },
      { ...CTX, platform: 'v-too-few' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid')

    register(makeFakeMessenger('v-too-many'))
    r = await handleAskOp(
      { question: 'q?', choices: Array.from({ length: 10 }, (_, i) => `c${i}`) },
      { ...CTX, platform: 'v-too-many' },
    )
    expect(r.ok).toBe(false)
  })

  it('rejects non-string choice', async () => {
    register(makeFakeMessenger('v-bad-choice'))
    const r = await handleAskOp(
      { question: 'q?', choices: ['ok', 42] },
      { ...CTX, platform: 'v-bad-choice' },
    )
    expect(r.ok).toBe(false)
  })

  it('rejects when messenger not registered', async () => {
    const r = await handleAskOp(
      { question: 'q?', choices: ['a', 'b'] },
      { ...CTX, platform: 'never-registered' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no-messenger')
  })
})

describe('handleAskOp — happy paths', () => {
  it('resolves messenger via fuzzy platform mapping (wechat → wechat-ilink)', async () => {
    const m = makeFakeMessenger('wechat-ilink', { withCards: false })
    register(m)
    const ctx = { ...CTX, platform: 'wechat' }
    const promise = handleAskOp({ question: 'pick one', choices: ['Yes', 'No'], timeoutSec: 5 }, ctx)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, '1')).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.label).toBe('Yes')
  })

  it('sends ChoiceCard when messenger supports it', async () => {
    const m = makeFakeMessenger('h-card-1', { withCards: true })
    register(m)
    const ctx = { ...CTX, platform: 'h-card-1' }
    const promise = handleAskOp({ question: 'pick one', choices: ['Yes', 'No'], timeoutSec: 5 }, ctx)
    // Card should be dispatched synchronously before we await; check
    // by reading the captured calls after a microtask flush.
    await new Promise<void>((r) => setImmediate(r))
    expect(m.cards.length).toBe(1)
    expect(m.cards[0].threadId).toBe('t1')
    expect(m.cards[0].prompt.choices).toHaveLength(2)
    expect(m.cards[0].prompt.choices[0].data).toMatch(/^ask:[0-9a-f-]+:1$/)
    expect(m.texts.length).toBe(0)
    // Resolve via button so the promise completes.
    tryResolvePendingAskByButton(m.cards[0].prompt.choices[0].data)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.index).toBe(1)
      expect(r.result.label).toBe('Yes')
      expect(r.result.via).toBe('button')
    }
  })

  it('falls back to text when messenger lacks sendChoiceCard', async () => {
    const m = makeFakeMessenger('h-text-1', { withCards: false })
    register(m)
    // sink.deliver uses the messenger's sendMessage; bypass the
    // outbox by registering our fake under a fresh platform name.
    const ctx = { ...CTX, platform: 'h-text-1' }
    const promise = handleAskOp({ question: 'pick one', choices: ['Yes', 'No'], timeoutSec: 5 }, ctx)
    // Allow sink.deliver microtasks to settle (it uses setImmediate
    // internally before write).
    await new Promise<void>((r) => setTimeout(r, 50))
    // text either landed via sendMessage OR queued in the outbox.
    // The test environment doesn't run the outbox worker; that's fine —
    // we only need to confirm no card was sent.
    expect(m.cards.length).toBe(0)
    // Resolve via inbound text.
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, 'no')).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.label).toBe('No')
      expect(r.result.via).toBe('text')
    }
  })

  it('resolves via inbound text by numeric index', async () => {
    const m = makeFakeMessenger('h-num-1')
    register(m)
    const ctx = { ...CTX, platform: 'h-num-1' }
    const promise = handleAskOp({ question: 'q', choices: ['alpha', 'beta', 'gamma'] }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, '2')).toBe(true)
    const r = await promise
    if (r.ok) {
      expect(r.result.index).toBe(2)
      expect(r.result.label).toBe('beta')
    }
  })

  it('resolves via inbound text by label substring (case-insensitive)', async () => {
    const m = makeFakeMessenger('h-sub-1')
    register(m)
    const ctx = { ...CTX, platform: 'h-sub-1' }
    const promise = handleAskOp({ question: 'q', choices: ['Approve', 'Reject'] }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, 'go ahead and approve please')).toBe(true)
    const r = await promise
    if (r.ok) expect(r.result.label).toBe('Approve')
  })

  it('resolves via inbound text by letter (a/b)', async () => {
    const m = makeFakeMessenger('h-letter-1')
    register(m)
    const ctx = { ...CTX, platform: 'h-letter-1' }
    const promise = handleAskOp({ question: 'q', choices: ['first', 'second', 'third'] }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, 'c')).toBe(true)
    const r = await promise
    if (r.ok) expect(r.result.index).toBe(3)
  })

  it('non-matching text does NOT consume the ask', async () => {
    const m = makeFakeMessenger('h-nomatch-1')
    register(m)
    const ctx = { ...CTX, platform: 'h-nomatch-1' }
    const p: Promise<AskResult> = handleAskOp({ question: 'q', choices: ['a', 'b'], timeoutSec: 5 }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, 'something completely different')).toBe(false)
    // Pending should still exist; resolve via valid text so the test
    // doesn't leak a long-lived timer.
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, 'a')).toBe(true)
    await p
  })
})

describe('handleAskOp — timeout', () => {
  it('resolves with timeout reason after timeoutSec', async () => {
    const m = makeFakeMessenger('to-1')
    register(m)
    const ctx = { ...CTX, platform: 'to-1' }
    const t0 = Date.now()
    const r = await handleAskOp({ question: 'q', choices: ['x', 'y'], timeoutSec: 5 }, ctx)
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('timeout')
      expect(r.error).toContain('5s')
    }
    expect(elapsed).toBeGreaterThanOrEqual(4_900)
    expect(elapsed).toBeLessThan(6_500)
  }, 10_000)
})

describe('button resolution', () => {
  it('tryResolvePendingAskByButton returns false on unknown data', () => {
    expect(tryResolvePendingAskByButton('apv:foo:y')).toBe(false)  // wrong prefix
    expect(tryResolvePendingAskByButton('ask:bogus:9999')).toBe(false)  // no such pending
    expect(tryResolvePendingAskByButton('ask:malformed')).toBe(false)
  })
})

describe('disallowed-text-reply mode', () => {
  it('text replies are IGNORED when allowTextReply=false', async () => {
    const m = makeFakeMessenger('strict-1')
    register(m)
    const ctx = { ...CTX, platform: 'strict-1' }
    const p = handleAskOp({
      question: 'q', choices: ['a', 'b'], timeoutSec: 5,
      allowTextReply: false,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, '1')).toBe(false)
    // Resolve via button so we don't wait on the timeout.
    const card = m.cards[0]
    expect(card).toBeDefined()
    tryResolvePendingAskByButton(card.prompt.choices[0].data)
    const r = await p
    expect(r.ok).toBe(true)
  })
})

describe('listPendingAsks', () => {
  it('reports pending count + age', async () => {
    const m = makeFakeMessenger('list-1')
    register(m)
    const ctx = { ...CTX, platform: 'list-1' }
    const p = handleAskOp({ question: 'q', choices: ['a', 'b'], timeoutSec: 5 }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    const list = listPendingAsks()
    expect(list.length).toBe(1)
    expect(list[0].platform).toBe('list-1')
    expect(list[0].choices).toBe(2)
    expect(list[0].ageMs).toBeLessThan(1_000)
    tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, 'a')
    await p
    expect(listPendingAsks().length).toBe(0)
  })
})
