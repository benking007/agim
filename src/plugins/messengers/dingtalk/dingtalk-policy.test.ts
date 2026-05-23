// Batch 1 (#4) + (#7) — pure-function tests for the access policy
// evaluator + ack-reaction glyph table.

import { describe, it, expect } from 'bun:test'
import { evalAccessPolicy, ACK_GLYPHS, planDingTalkAccounts } from './dingtalk-adapter.js'

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

describe('planDingTalkAccounts — multi-account resolution', () => {
  it('single-account legacy config yields exactly { default: cfg }', () => {
    const m = planDingTalkAccounts({ clientId: 'k1', clientSecret: 's1' })
    expect([...m.keys()]).toEqual(['default'])
    expect(m.get('default')?.clientId).toBe('k1')
  })

  it('accounts dict with no top-level creds yields each entry as its own client', () => {
    const m = planDingTalkAccounts({
      clientId: '', clientSecret: '',
      accounts: {
        teamA: { clientId: 'kA', clientSecret: 'sA' },
        teamB: { clientId: 'kB', clientSecret: 'sB' },
      },
    })
    expect([...m.keys()].sort()).toEqual(['teamA', 'teamB'])
    expect(m.get('teamA')?.clientId).toBe('kA')
    expect(m.get('teamB')?.clientSecret).toBe('sB')
  })

  it('account-block overrides win over top-level defaults', () => {
    const m = planDingTalkAccounts({
      clientId: 'global', clientSecret: 'global',
      dmPolicy: 'open',
      accounts: {
        strict: { dmPolicy: 'allowlist', allowFrom: ['ops'] },
      },
    })
    expect(m.get('default')?.dmPolicy).toBe('open')
    const strict = m.get('strict')
    expect(strict?.dmPolicy).toBe('allowlist')
    expect(strict?.allowFrom).toEqual(['ops'])
    expect(strict?.clientId).toBe('global') // inherits credentials
  })

  it('explicit accounts.default replaces the implicit top-level default', () => {
    const m = planDingTalkAccounts({
      clientId: 'top', clientSecret: 'top',
      accounts: {
        default: { clientId: 'override', clientSecret: 'override' },
      },
    })
    expect([...m.keys()]).toEqual(['default'])
    expect(m.get('default')?.clientId).toBe('override')
  })

  it('enabled=false filters the account out', () => {
    const m = planDingTalkAccounts({
      clientId: 'top', clientSecret: 'top',
      accounts: {
        offline: { clientId: 'offl', clientSecret: 'offl', enabled: false },
        live:    { clientId: 'live', clientSecret: 'live' },
      },
    })
    expect([...m.keys()].sort()).toEqual(['default', 'live'])
  })

  it('account missing both top-level + account-level credentials is skipped', () => {
    const m = planDingTalkAccounts({
      clientId: '', clientSecret: '',
      accounts: {
        broken: { /* no creds anywhere */ },
        ok:     { clientId: 'k', clientSecret: 's' },
      },
    })
    expect([...m.keys()]).toEqual(['ok'])
  })
})
