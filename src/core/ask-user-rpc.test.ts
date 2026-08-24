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
  handleAskButton,
  listPendingAsks,
  listPendingAskCards,
  threadHasPendingAsk,
  _resetAskBusForTests,
  type AskResult,
} from './ask-user-rpc.js'
import { registry } from './registry.js'
import type { MessengerAdapter, ChoiceCardPrompt } from './types.js'

interface FakeMessenger extends MessengerAdapter {
  cards: Array<{ threadId: string; prompt: ChoiceCardPrompt }>
  texts: Array<{ threadId: string; text: string }>
  updates: Array<{ threadId: string; messageId: string; prompt: ChoiceCardPrompt }>
}

function makeFakeMessenger(
  name: string,
  opts: { withCards?: boolean; withToggle?: boolean } = { withCards: true },
): FakeMessenger {
  const cards: FakeMessenger['cards'] = []
  const texts: FakeMessenger['texts'] = []
  const updates: FakeMessenger['updates'] = []
  const base = {
    name,
    cards,
    texts,
    updates,
    async start() { /* noop */ },
    async stop() { /* noop */ },
    onMessage(_: (ctx: unknown) => Promise<void>) { /* noop */ },
    async sendMessage(threadId: string, text: string) { texts.push({ threadId, text }) },
  } as unknown as FakeMessenger
  if (opts.withCards !== false) {
    (base as MessengerAdapter).sendChoiceCard = async (threadId: string, prompt: ChoiceCardPrompt) => {
      cards.push({ threadId, prompt })
      return { messageId: `m-${cards.length}` }
    }
  }
  // A toggle-capable adapter (Telegram-like) also implements updateChoiceCard,
  // which flips ask-user-rpc into server-side stateful card mode.
  if (opts.withToggle) {
    (base as MessengerAdapter).updateChoiceCard = async (threadId: string, messageId: string, prompt: ChoiceCardPrompt) => {
      updates.push({ threadId, messageId, prompt })
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

  it('rejects strict text-disabled asks when cards are unavailable', async () => {
    const m = makeFakeMessenger('v-no-card', { withCards: false })
    register(m)
    const r = await handleAskOp(
      { question: 'q?', choices: ['a', 'b'], allowTextReply: false },
      { ...CTX, platform: 'v-no-card' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid')
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

  it('lists pending ask cards for reconnect replay', async () => {
    const m = makeFakeMessenger('web', { withCards: true })
    register(m)
    const ctx = { ...CTX, platform: 'web' }
    const promise = handleAskOp(
      { question: '按此实施？', choices: ['按此方案实施', '先只做核心 3 tab'], timeoutSec: 30 },
      ctx,
    )
    await new Promise<void>((r) => setImmediate(r))
    const cards = listPendingAskCards({ platform: 'web', threadId: ctx.threadId })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.prompt.body).toContain('按此实施')
    expect(cards[0]?.messageId).toBeTruthy()
    tryResolvePendingAskByButton(m.cards[0]!.prompt.choices[0]!.data)
    await promise
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

  it('resolves multi-select ask via text reply', async () => {
    const m = makeFakeMessenger('h-multi-text')
    register(m)
    const ctx = { ...CTX, platform: 'h-multi-text' }
    const promise = handleAskOp({
      question: 'pick',
      choices: ['alpha', 'beta', 'gamma'],
      selectionMode: 'multi',
      minSelections: 2,
      maxSelections: 3,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, '1,3')).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.selectionMode).toBe('multi')
      expect(r.result.indexes).toEqual([1, 3])
      expect(r.result.labels).toEqual(['alpha', 'gamma'])
      expect(r.result.index).toBe(1)
    }
  })

  it('resolves custom input via text when enabled', async () => {
    const m = makeFakeMessenger('h-custom-text')
    register(m)
    const ctx = { ...CTX, platform: 'h-custom-text' }
    const promise = handleAskOp({
      question: 'pick',
      choices: ['alpha', 'beta'],
      allowCustomInput: true,
      customInputLabel: '其他方案',
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, '我想走第三种方案')).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.customText).toBe('我想走第三种方案')
      expect(r.result.label).toBe('其他方案')
      expect(r.result.index).toBe(0)
    }
  })

  it('resolves multi-select via button payload', async () => {
    const m = makeFakeMessenger('tui', { withCards: true })
    register(m)
    const ctx = { ...CTX, platform: 'tui' }
    const promise = handleAskOp({
      question: 'pick',
      choices: ['a', 'b', 'c'],
      selectionMode: 'multi',
      minSelections: 2,
      maxSelections: 3,
      allowTextReply: false,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    const firstData = m.cards[0]?.prompt.choices[0]?.data ?? ''
    const reqId = /^ask:([^:]+):/.exec(firstData)?.[1]
    expect(reqId).toBeTruthy()
    expect(tryResolvePendingAskByButton(`ask:${reqId}:multi:1,2`)).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.selectionMode).toBe('multi')
      expect(r.result.indexes).toEqual([1, 2])
      expect(r.result.via).toBe('button')
    }
  })

  it('resolves custom input via button payload', async () => {
    const m = makeFakeMessenger('tui', { withCards: true })
    register(m)
    const ctx = { ...CTX, platform: 'tui' }
    const promise = handleAskOp({
      question: 'pick',
      choices: ['a', 'b'],
      allowCustomInput: true,
      allowTextReply: false,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    const firstData = m.cards[0]?.prompt.choices[0]?.data ?? ''
    const reqId = /^ask:([^:]+):/.exec(firstData)?.[1]
    expect(reqId).toBeTruthy()
    const encoded = Buffer.from('my custom answer', 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    expect(tryResolvePendingAskByButton(`ask:${reqId}:custom:${encoded}`)).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.customText).toBe('my custom answer')
      expect(r.result.via).toBe('button')
    }
  })

  it('sends a card on web for multi-select + custom (not just single)', async () => {
    // The web client renders the full card client-side, so the gate lets
    // web — like tui — get a card for rich ask modes rather than the
    // "reply 1/2/3" text fallback. Resolution then flows through the
    // button payload the browser builds (ask:<reqId>:multi:…).
    const m = makeFakeMessenger('web', { withCards: true })
    register(m)
    const ctx = { ...CTX, platform: 'web' }
    const promise = handleAskOp({
      question: 'pick some',
      choices: ['a', 'b', 'c'],
      selectionMode: 'multi',
      minSelections: 1,
      maxSelections: 3,
      allowCustomInput: true,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(m.cards.length).toBe(1)
    expect(m.texts.length).toBe(0)
    const firstData = m.cards[0]?.prompt.choices[0]?.data ?? ''
    const reqId = /^ask:([^:]+):/.exec(firstData)?.[1]
    expect(reqId).toBeTruthy()
    expect(tryResolvePendingAskByButton(`ask:${reqId}:multi:1,3`)).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.selectionMode).toBe('multi')
      expect(r.result.indexes).toEqual([1, 3])
      expect(r.result.via).toBe('button')
    }
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

describe('server-side toggle (Telegram-style)', () => {
  function reqIdOf(m: FakeMessenger): string {
    const data = m.cards[0]?.prompt.choices[0]?.data ?? ''
    const id = /^ask:([^:]+):/.exec(data)?.[1]
    if (!id) throw new Error('no reqId in card')
    return id
  }

  it('multi-select renders toggle + submit buttons and a card is sent (no text fallback)', async () => {
    const m = makeFakeMessenger('tg-multi', { withToggle: true })
    register(m)
    const ctx = { ...CTX, platform: 'tg-multi' }
    const promise = handleAskOp({
      question: 'pick', choices: ['a', 'b', 'c'],
      selectionMode: 'multi', minSelections: 1, maxSelections: 3,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    // Card path, not text.
    expect(m.cards.length).toBe(1)
    expect(m.texts.length).toBe(0)
    const labels = m.cards[0].prompt.choices.map((c) => c.label)
    const datas = m.cards[0].prompt.choices.map((c) => c.data)
    expect(labels.some((l) => l.startsWith('☐'))).toBe(true)         // toggle checkbox
    expect(datas.some((d) => /:t:\d+$/.test(d))).toBe(true)          // toggle data
    expect(datas.some((d) => /:ok$/.test(d))).toBe(true)             // submit button
    // every callback_data stays under Telegram's 64-byte cap
    for (const d of datas) expect(Buffer.byteLength(d, 'utf8')).toBeLessThan(64)
    // clean up the pending so the timer doesn't linger
    const reqId = reqIdOf(m)
    handleAskButton(`ask:${reqId}:t:1`)
    handleAskButton(`ask:${reqId}:ok`)
    await promise
  })

  it('toggle accumulates server-side; submit resolves with the picked set', async () => {
    const m = makeFakeMessenger('tg-acc', { withToggle: true })
    register(m)
    const ctx = { ...CTX, platform: 'tg-acc' }
    const promise = handleAskOp({
      question: 'pick', choices: ['a', 'b', 'c'],
      selectionMode: 'multi', minSelections: 2, maxSelections: 3,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    const reqId = reqIdOf(m)

    const t1 = handleAskButton(`ask:${reqId}:t:1`)
    expect(t1.kind).toBe('rerender')
    if (t1.kind === 'rerender') {
      expect(t1.card.choices[0].label.startsWith('☑️')).toBe(true)   // option 1 now checked
    }
    // submit too early (only 1 picked, min 2) → invalid, not resolved
    const early = handleAskButton(`ask:${reqId}:ok`)
    expect(early.kind).toBe('invalid')

    handleAskButton(`ask:${reqId}:t:3`)               // now {1,3}
    const submit = handleAskButton(`ask:${reqId}:ok`)
    expect(submit.kind).toBe('resolved')
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.selectionMode).toBe('multi')
      expect(r.result.indexes).toEqual([1, 3])
      expect(r.result.via).toBe('button')
    }
  })

  it('toggling the same index twice clears it', async () => {
    const m = makeFakeMessenger('tg-tog', { withToggle: true })
    register(m)
    const ctx = { ...CTX, platform: 'tg-tog' }
    const promise = handleAskOp({
      question: 'pick', choices: ['a', 'b'],
      selectionMode: 'multi', minSelections: 1, maxSelections: 2,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    const reqId = reqIdOf(m)
    handleAskButton(`ask:${reqId}:t:1`)               // {1}
    const off = handleAskButton(`ask:${reqId}:t:1`)   // {}
    expect(off.kind).toBe('rerender')
    if (off.kind === 'rerender') {
      expect(off.card.choices[0].label.startsWith('☐')).toBe(true)
    }
    const early = handleAskButton(`ask:${reqId}:ok`)
    expect(early.kind).toBe('invalid')                // nothing selected, min 1
    // resolve to clean up
    handleAskButton(`ask:${reqId}:t:2`)
    handleAskButton(`ask:${reqId}:ok`)
    await promise
  })

  it('custom-trigger enters await mode; the next text becomes the answer', async () => {
    const m = makeFakeMessenger('tg-custom', { withToggle: true })
    register(m)
    const ctx = { ...CTX, platform: 'tg-custom' }
    const promise = handleAskOp({
      question: 'pick', choices: ['a', 'b'],
      allowCustomInput: true,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    const reqId = reqIdOf(m)
    // The card carries a custom-trigger button (bare `:custom`).
    expect(m.cards[0].prompt.choices.some((c) => c.data === `ask:${reqId}:custom`)).toBe(true)
    const trig = handleAskButton(`ask:${reqId}:custom`)
    expect(trig.kind).toBe('await-custom')
    // Now a typed reply is taken verbatim (would otherwise match label "a").
    expect(tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, '我要自定义')).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.customText).toBe('我要自定义')
      expect(r.result.via).toBe('text')
    }
  })

  it('details link is attached to the card when a valid http url is given', async () => {
    const m = makeFakeMessenger('tg-link', { withToggle: true })
    register(m)
    const ctx = { ...CTX, platform: 'tg-link' }
    const promise = handleAskOp({
      question: 'pick', choices: ['a', 'b'],
      selectionMode: 'multi', minSelections: 1, maxSelections: 2,
      detailsUrl: 'https://example.com/v/abc', detailsLabel: '查看 diff',
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(m.cards[0].prompt.links).toEqual([{ label: '查看 diff', url: 'https://example.com/v/abc' }])
    const reqId = reqIdOf(m)
    handleAskButton(`ask:${reqId}:t:1`); handleAskButton(`ask:${reqId}:ok`)
    await promise
  })

  it('invalid details url (non-http) is dropped, no links', async () => {
    const m = makeFakeMessenger('tg-badlink', { withToggle: true })
    register(m)
    const ctx = { ...CTX, platform: 'tg-badlink' }
    const promise = handleAskOp({
      question: 'pick', choices: ['a', 'b'],
      detailsUrl: 'javascript:alert(1)',
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    expect(m.cards[0].prompt.links).toBeUndefined()
    tryResolvePendingAskByButton(`ask:${reqIdOf(m)}:1`)
    await promise
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
    expect(threadHasPendingAsk(ctx.platform, ctx.channelId, ctx.threadId)).toBe(true)
    tryResolvePendingAsk(ctx.platform, ctx.channelId, ctx.threadId, 'a')
    await p
    expect(listPendingAsks().length).toBe(0)
    expect(threadHasPendingAsk(ctx.platform, ctx.channelId, ctx.threadId)).toBe(false)
  })

  it('listPendingAskCards rebuilds prompts for web replay', async () => {
    const m = makeFakeMessenger('list-cards')
    register(m)
    const ctx = { ...CTX, platform: 'list-cards', threadId: 'web-t1' }
    const p = handleAskOp({
      question: 'Which path?',
      choices: ['keep going', 'stop here'],
      timeoutSec: 30,
    }, ctx)
    await new Promise<void>((r) => setImmediate(r))
    const cards = listPendingAskCards({ platform: 'list-cards', threadId: 'web-t1' })
    expect(cards).toHaveLength(1)
    expect(cards[0].prompt.body).toBe('Which path?')
    expect(cards[0].prompt.choices.map((c) => c.label)).toEqual([
      '1. keep going',
      '2. stop here',
    ])
    expect(cards[0].messageId).toBeTruthy()
    expect(listPendingAskCards({ platform: 'list-cards', threadId: 'other' })).toHaveLength(0)
    tryResolvePendingAskByButton(`ask:${cards[0].reqId}:1`)
    await p
    expect(listPendingAskCards({ platform: 'list-cards' })).toHaveLength(0)
  })
})
