// Tests for access-token — focus on the F5 last_used_at write-throttle
// that shrinks the tokens.json read-modify-write race window.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SAVED = { AGIM_HOME: process.env.AGIM_HOME }
let home: string

function readTokens(file: string): { tokens: Array<{ id: string; last_used_at: number | null }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}
function setLastUsed(file: string, value: number | null): void {
  const data = readTokens(file)
  data.tokens[0].last_used_at = value
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

describe('access-token last_used_at throttle (F5)', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agim-tok-test-'))
    process.env.AGIM_HOME = home
  })
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
    if (SAVED.AGIM_HOME === undefined) delete process.env.AGIM_HOME; else process.env.AGIM_HOME = SAVED.AGIM_HOME
  })

  it('does NOT rewrite tokens.json when last_used_at is fresh (<30s)', async () => {
    const { createToken, verifyToken, getTokensFilePath } = await import('./access-token.js')
    const { raw, id } = createToken('t')
    const file = getTokensFilePath()
    const now = Math.floor(Date.now() / 1000)
    setLastUsed(file, now - 5)  // fresh

    expect(verifyToken(raw)).toBe(id)
    expect(readTokens(file).tokens[0].last_used_at).toBe(now - 5)  // unchanged
  })

  it('DOES update last_used_at when stale (>=30s)', async () => {
    const { createToken, verifyToken, getTokensFilePath } = await import('./access-token.js')
    const { raw, id } = createToken('t')
    const file = getTokensFilePath()
    const now = Math.floor(Date.now() / 1000)
    setLastUsed(file, now - 100)  // stale

    expect(verifyToken(raw)).toBe(id)
    expect(readTokens(file).tokens[0].last_used_at!).toBeGreaterThanOrEqual(now - 1)
  })

  it('updates last_used_at on first use (was null)', async () => {
    const { createToken, verifyToken, getTokensFilePath } = await import('./access-token.js')
    const { raw } = createToken('t')
    const file = getTokensFilePath()
    expect(readTokens(file).tokens[0].last_used_at).toBeNull()
    verifyToken(raw)
    expect(typeof readTokens(file).tokens[0].last_used_at).toBe('number')
  })

  it('still rejects an invalid token', async () => {
    const { createToken, verifyToken } = await import('./access-token.js')
    createToken('t')
    expect(verifyToken('agim_deadbeef')).toBeNull()
  })

  it('keeps a missing role as admin and does not treat bridge as admin', async () => {
    const { createToken, getTokenRole, isAdminTokenId, getTokensFilePath } = await import('./access-token.js')
    const admin = createToken('admin-default')
    const user = createToken('member', { role: 'user' })
    const bridge = createToken('bridge', { role: 'bridge' })
    expect(getTokenRole(admin.id)).toBe('admin')
    expect(isAdminTokenId(admin.id)).toBe(true)
    expect(getTokenRole(user.id)).toBe('user')
    expect(isAdminTokenId(user.id)).toBe(false)
    expect(getTokenRole(bridge.id)).toBe('bridge')
    expect(isAdminTokenId(bridge.id)).toBe(false)
    const file = JSON.parse(readFileSync(getTokensFilePath(), 'utf-8')) as {
      tokens: Array<{ id: string; role?: string }>
    }
    const legacy = file.tokens[0]
    delete legacy.role
    writeFileSync(getTokensFilePath(), JSON.stringify({ tokens: file.tokens }, null, 2))
    expect(getTokenRole(legacy.id)).toBe('admin')
  })
})
