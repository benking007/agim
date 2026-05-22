// Batch 1 (#4) + (#7) — pure-function tests for the access policy
// evaluator + ack-reaction glyph table.

import { describe, it, expect } from 'bun:test'
import { evalAccessPolicy, ACK_GLYPHS } from './dingtalk-adapter.js'

describe('evalAccessPolicy — DM modes', () => {
  it('open allows any sender', () => {
    const r = evalAccessPolicy({ dmPolicy: 'open' }, { isGroup: false, senderStaffId: 'alice' })
    expect(r.allowed).toBe(true)
    expect(r.pairedNewSender).toBeUndefined()
  })

  it('allowlist permits only listed senders', () => {
    const cfg = { dmPolicy: 'allowlist' as const, allowFrom: ['alice'] }
    expect(evalAccessPolicy(cfg, { isGroup: false, senderStaffId: 'alice' }).allowed).toBe(true)
    expect(evalAccessPolicy(cfg, { isGroup: false, senderStaffId: 'bob' }).allowed).toBe(false)
  })

  it('allowlist with no list rejects everyone', () => {
    const r = evalAccessPolicy({ dmPolicy: 'allowlist' }, { isGroup: false, senderStaffId: 'alice' })
    expect(r.allowed).toBe(false)
  })

  it('pairing: first sender returns pairedNewSender', () => {
    const r = evalAccessPolicy({ dmPolicy: 'pairing' }, { isGroup: false, senderStaffId: 'alice' })
    expect(r.allowed).toBe(true)
    expect(r.pairedNewSender).toBe('alice')
  })

  it('pairing: subsequent paired sender passes without re-pairing', () => {
    const r = evalAccessPolicy(
      { dmPolicy: 'pairing', allowFrom: ['alice'] },
      { isGroup: false, senderStaffId: 'alice' },
    )
    expect(r.allowed).toBe(true)
    expect(r.pairedNewSender).toBeUndefined()
  })

  it('pairing: a different sender after pairing is rejected', () => {
    const r = evalAccessPolicy(
      { dmPolicy: 'pairing', allowFrom: ['alice'] },
      { isGroup: false, senderStaffId: 'bob' },
    )
    expect(r.allowed).toBe(false)
  })
})

describe('evalAccessPolicy — group modes', () => {
  it('open passes any group sender', () => {
    const r = evalAccessPolicy({ groupPolicy: 'open' }, { isGroup: true, senderStaffId: 'alice' })
    expect(r.allowed).toBe(true)
  })

  it('disabled rejects all group messages', () => {
    const r = evalAccessPolicy({ groupPolicy: 'disabled' }, { isGroup: true, senderStaffId: 'alice' })
    expect(r.allowed).toBe(false)
  })

  it('allowlist uses groupAllowFrom, not allowFrom', () => {
    const cfg = {
      groupPolicy: 'allowlist' as const,
      groupAllowFrom: ['alice'],
      allowFrom: ['bob'],
    }
    expect(evalAccessPolicy(cfg, { isGroup: true, senderStaffId: 'alice' }).allowed).toBe(true)
    expect(evalAccessPolicy(cfg, { isGroup: true, senderStaffId: 'bob' }).allowed).toBe(false)
  })
})

describe('ACK_GLYPHS table', () => {
  it('emoji + kaomoji have all four states defined', () => {
    for (const mode of ['emoji', 'kaomoji'] as const) {
      for (const state of ['received', 'working', 'done', 'failed'] as const) {
        const glyph = ACK_GLYPHS[mode][state]
        expect(typeof glyph).toBe('string')
        expect(glyph.length).toBeGreaterThan(0)
      }
    }
  })
})
