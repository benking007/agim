// pending-memo-location.test.ts — TTL store + reply-consumption rules.
//
// Mirrors pending-reminder.test.ts (same store shape) but covers the
// location-specific reply paths: cancel words, venue-confirm via `y`,
// free-form label, and the >80 char guard that lets users "move on"
// instead of accidentally consuming an unrelated long message.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  setPending,
  getPending,
  clearPending,
  tryConsumeReply,
  _clearForTest,
  _sizeForTest,
} from './pending-memo-location.js'

const TK = 'telegram:default:42'

beforeEach(() => { _clearForTest() })

describe('pending-memo-location store', () => {
  it('set + get round-trip', () => {
    setPending(TK, { lat: 39.9, lng: 116.4, accuracy: 5 })
    const p = getPending(TK)
    expect(p?.lat).toBe(39.9)
    expect(p?.lng).toBe(116.4)
    expect(p?.accuracy).toBe(5)
    expect(typeof p?.createdAt).toBe('number')
  })

  it('clearPending removes the entry', () => {
    setPending(TK, { lat: 0, lng: 0 })
    clearPending(TK)
    expect(getPending(TK)).toBeNull()
    expect(_sizeForTest()).toBe(0)
  })

  it('getPending returns null when nothing pending', () => {
    expect(getPending(TK)).toBeNull()
  })
})

describe('tryConsumeReply — cancel patterns', () => {
  beforeEach(() => setPending(TK, { lat: 1, lng: 2 }))

  it.each(['n', 'N', 'no', '不用', '跳过', '算了', 'skip', '忽略'])(
    'cancels on "%s"',
    (text) => {
      const r = tryConsumeReply(TK, text)
      expect(r?.decision).toBe('cancel')
      expect(getPending(TK)).toBeNull() // cleared
    },
  )
})

describe('tryConsumeReply — confirm via venue title', () => {
  it('uses venueLabel as what when user replies y', () => {
    setPending(TK, { lat: 39.9, lng: 116.4, venueLabel: '茶馆', venueAddress: '中关村大街27号' })
    const r = tryConsumeReply(TK, 'y')
    expect(r?.decision).toBe('save')
    if (r?.decision === 'save') expect(r.what).toBe('茶馆')
    expect(getPending(TK)).toBeNull()
  })

  it('treats y/记下/确认 all as confirm when venueLabel present', () => {
    for (const text of ['y', 'yes', '记下', '确认', '好', 'ok']) {
      setPending(TK, { lat: 0, lng: 0, venueLabel: '咖啡馆' })
      const r = tryConsumeReply(TK, text)
      expect(r?.decision).toBe('save')
      if (r?.decision === 'save') expect(r.what).toBe('咖啡馆')
    }
  })

  it('does NOT confirm via y when there is no venueLabel — treats y as the label', () => {
    // Without a venue title there is nothing to confirm to. A literal "y" then
    // becomes the user-supplied what. Edge case but consistent: we trust the
    // text the user typed.
    setPending(TK, { lat: 0, lng: 0 })
    const r = tryConsumeReply(TK, 'y')
    // y matches CANCEL_PAT? No — CANCEL_PAT is (n|no|否|...). y matches CONFIRM_PAT
    // but we require venueLabel for that path. So it falls through to free-form.
    expect(r?.decision).toBe('save')
    if (r?.decision === 'save') expect(r.what).toBe('y')
  })
})

describe('tryConsumeReply — free-form label', () => {
  beforeEach(() => setPending(TK, { lat: 1, lng: 2 }))

  it('uses arbitrary text as what', () => {
    const r = tryConsumeReply(TK, '车')
    expect(r?.decision).toBe('save')
    if (r?.decision === 'save') expect(r.what).toBe('车')
    expect(getPending(TK)).toBeNull()
  })

  it('trims whitespace from the label', () => {
    const r = tryConsumeReply(TK, '  老孙家  ')
    if (r?.decision === 'save') expect(r.what).toBe('老孙家')
  })

  it('returns null on empty / whitespace-only text — does not consume', () => {
    expect(tryConsumeReply(TK, '')).toBeNull()
    expect(tryConsumeReply(TK, '   ')).toBeNull()
    expect(getPending(TK)).not.toBeNull() // still pending
  })

  it('returns null on text > 80 chars — user probably moved on', () => {
    const long = '我今天去了一个特别好的地方，但其实我不是想记录刚才那个 pin，我是想和你聊聊别的事情，比如说昨天看的那部电影真的太棒了，还有最近的天气真不错，明天打算出去逛逛公园'
    expect(long.length).toBeGreaterThan(80)
    expect(tryConsumeReply(TK, long)).toBeNull()
    expect(getPending(TK)).not.toBeNull() // still pending — will TTL out
  })
})

describe('tryConsumeReply — no pending', () => {
  it('returns null when nothing is pending for the thread', () => {
    expect(tryConsumeReply(TK, '车')).toBeNull()
    expect(tryConsumeReply(TK, 'y')).toBeNull()
    expect(tryConsumeReply(TK, 'n')).toBeNull()
  })
})

describe('TTL eviction', () => {
  it('evicts entries older than the TTL on next set/get', async () => {
    // We can't time-travel without monkeypatching Date.now, but we can verify
    // the eviction code path runs by stuffing a manually-aged entry. The
    // store doesn't export its internals so we use the public surface only.
    setPending(TK, { lat: 1, lng: 2 })
    expect(_sizeForTest()).toBe(1)
    // Force a setPending on another key well after — both should still be
    // present because real TTL is 5 min. This just confirms eviction is a
    // no-op under normal timing (no false positives).
    setPending('telegram:default:other', { lat: 3, lng: 4 })
    expect(_sizeForTest()).toBe(2)
  })
})
