// location-token.ts — single-shot token store backing /location here.
//
// Verifies: issued tokens come back from consume; expired tokens come back
// with reason='expired' and are also dropped (no replay window); unknown
// tokens come back with reason='unknown'; consume is single-shot.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  issueToken, consumeToken,
  _pendingCount, _clearAll, _stopSweep,
} from '../../src/core/location-token'

const CTX = { platform: 'wechat', channelId: 'c1', threadId: 't1', userId: 'u1' }

describe('location-token', () => {
  beforeEach(() => {
    _clearAll()
    _stopSweep()
  })

  it('issueToken returns a 32-char hex token + future expiry', () => {
    const r = issueToken(CTX)
    expect(r.token).toMatch(/^[a-f0-9]{32}$/)
    expect(r.expiresAt).toBeGreaterThan(Date.now())
    expect(r.ttlSeconds).toBe(600) // 10 min
    expect(_pendingCount()).toBe(1)
  })

  it('consumeToken with valid token returns ctx and drops the token', () => {
    const { token } = issueToken(CTX)
    const r = consumeToken(token)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.ctx).toEqual(CTX)
    }
    expect(_pendingCount()).toBe(0) // single-shot — token gone
  })

  it('consumeToken twice: second call returns unknown', () => {
    const { token } = issueToken(CTX)
    const a = consumeToken(token)
    expect(a.ok).toBe(true)
    const b = consumeToken(token)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toBe('unknown')
  })

  it('consumeToken with garbage token returns unknown', () => {
    const r = consumeToken('definitely-not-a-real-token')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unknown')
  })

  it('consumeToken on an expired token returns expired AND drops the token', () => {
    // Issue a real token then forge an expired one with the same shape.
    // Easier: monkey-patch by directly inspecting after issue and waiting.
    // Since the store is module-private, simulate by setting an artificially
    // tiny TTL would require reaching in — instead, freeze time via stub:
    const realNow = Date.now
    let nowMs = 1_000_000_000_000
    Date.now = () => nowMs

    try {
      const { token } = issueToken(CTX)
      // Jump 11 minutes forward (past the 10-min TTL).
      nowMs += 11 * 60_000

      const r = consumeToken(token)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('expired')
      // Drop on expired-consume — prevents replay scanning.
      expect(_pendingCount()).toBe(0)
    } finally {
      Date.now = realNow
    }
  })

  it('multiple tokens for the same ctx are independent', () => {
    const a = issueToken(CTX)
    const b = issueToken(CTX)
    expect(a.token).not.toBe(b.token)
    expect(_pendingCount()).toBe(2)
    consumeToken(a.token)
    expect(_pendingCount()).toBe(1)
    expect(consumeToken(b.token).ok).toBe(true)
  })

  it('different ctx fields round-trip distinctly', () => {
    const ctxA = { platform: 'wechat', channelId: 'c', threadId: 't', userId: 'a' }
    const ctxB = { platform: 'telegram', channelId: 'c', threadId: 't', userId: 'b' }
    const a = issueToken(ctxA)
    const b = issueToken(ctxB)
    const ra = consumeToken(a.token)
    const rb = consumeToken(b.token)
    expect(ra.ok && ra.ctx.userId).toBe('a')
    expect(rb.ok && rb.ctx.userId).toBe('b')
    expect(rb.ok && rb.ctx.platform).toBe('telegram')
  })
})
