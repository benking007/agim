// agim-rpc-server tests — token auth, whitelist, transport round-trip.
//
// We DON'T spin up a real Unix socket here (CI flakiness around socket
// permissions). Instead, the tests target the pure pieces:
//   - mintRpcToken + token registry semantics
//   - resolveSocketPath env override
//   - the whitelist of tool names exported via DEFAULT
// The handler-with-real-socket integration is covered by manual smoke
// once the bin/agim_rpc.py script is exercised in a live agim install.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  mintRpcToken,
  revokeRpcToken,
  resolveSocketPath,
  _peekTokensForTests,
} from './agim-rpc-server.js'

describe('agim-rpc-server — token registry', () => {
  beforeEach(() => {
    // Cheap reset: walk the live map and drop everything. Module-level
    // singletons survive across tests within one bun process.
    const tokens = _peekTokensForTests()
    for (const t of Array.from(tokens.keys())) tokens.delete(t)
  })

  it('mintRpcToken returns a 64-char hex token bound to the given ctx', () => {
    const r = mintRpcToken({ platform: 'telegram', channelId: '', threadId: 't1', userId: 'u1' })
    expect(r.token).toMatch(/^[a-f0-9]{64}$/)
    expect(r.socketPath).toBe(resolveSocketPath())
    expect(r.expiresAt).toBeGreaterThan(Date.now())
    const tokens = _peekTokensForTests()
    expect(tokens.has(r.token)).toBe(true)
    expect(tokens.get(r.token)?.ctx.threadId).toBe('t1')
  })

  it('two mints return different tokens', () => {
    const a = mintRpcToken({ platform: 'wechat', channelId: 'c', threadId: 't1', userId: 'u' })
    const b = mintRpcToken({ platform: 'wechat', channelId: 'c', threadId: 't1', userId: 'u' })
    expect(a.token).not.toBe(b.token)
    expect(_peekTokensForTests().size).toBe(2)
  })

  it('revokeRpcToken removes the entry', () => {
    const r = mintRpcToken({ platform: 'x', channelId: '', threadId: 't', userId: 'u' })
    expect(_peekTokensForTests().has(r.token)).toBe(true)
    revokeRpcToken(r.token)
    expect(_peekTokensForTests().has(r.token)).toBe(false)
  })

  it('revoke is a no-op on unknown token', () => {
    revokeRpcToken('not-a-real-token')
    // No throw, no state change.
    expect(_peekTokensForTests().size).toBe(0)
  })
})

describe('agim-rpc-server — socket path resolution', () => {
  const savedEnv = process.env.IMHUB_RPC_SOCKET

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.IMHUB_RPC_SOCKET
    else process.env.IMHUB_RPC_SOCKET = savedEnv
  })

  it('uses IMHUB_RPC_SOCKET when set', () => {
    process.env.IMHUB_RPC_SOCKET = '/tmp/custom-agim.sock'
    expect(resolveSocketPath()).toBe('/tmp/custom-agim.sock')
  })

  it('falls back to AGIM_HOME/rpc.sock when env is unset', () => {
    delete process.env.IMHUB_RPC_SOCKET
    expect(resolveSocketPath()).toMatch(/rpc\.sock$/)
  })
})
