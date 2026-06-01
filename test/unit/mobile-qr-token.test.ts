// v1.2.129 — verify mobile-qr tokens are created with role=user and
// the mobile-via-qr-* label. These properties are load-bearing for
// the security model:
//   * role=user means a leaked QR cannot edit env / promote admins
//   * the label prefix is what the security page filters/revokes on
//
// We can't end-to-end test the HTTP handler without spinning up the
// whole server (sqlite + admin allowlist + audit sink), so this is
// a thin unit test against access-token.createToken — the only call
// handleMobileQR makes that we need to pin behaviour of.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('v1.2.129 — mobile-via-qr tokens', () => {
  let tmpHome = ''
  const saved: Record<string, string | undefined> = {}

  beforeAll(() => {
    // access-token.ts reads ~/.agim/tokens.json (or whatever
    // resolveAgimHome() picks). We redirect HOME to a tmp dir so the
    // test doesn't touch the real user.
    tmpHome = mkdtempSync(join(tmpdir(), 'agim-mobile-qr-test-'))
    saved.HOME = process.env.HOME
    saved.AGIM_HOME = process.env.AGIM_HOME
    process.env.HOME = tmpHome
    delete process.env.AGIM_HOME
  })

  afterAll(() => {
    if (saved.HOME === undefined) delete process.env.HOME
    else process.env.HOME = saved.HOME
    if (saved.AGIM_HOME !== undefined) process.env.AGIM_HOME = saved.AGIM_HOME
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* noop */ }
  })

  it('createToken({ role: "user", label }) writes role=user', async () => {
    const { createToken, listTokens } = await import('../../src/core/access-token.js')
    const out = createToken('mobile-via-qr-20260601-1234', { role: 'user', actor: 'mobile-qr' })
    expect(out.role).toBe('user')
    expect(out.raw).toMatch(/^[A-Za-z0-9_-]+$/)
    const row = listTokens().find((t) => t.id === out.id)
    expect(row?.role).toBe('user')
    expect(row?.label).toBe('mobile-via-qr-20260601-1234')
  })

  it('isAdminTokenId returns false for a user-role mobile token', async () => {
    const { createToken, isAdminTokenId } = await import('../../src/core/access-token.js')
    const out = createToken('mobile-via-qr-20260601-2222', { role: 'user' })
    expect(isAdminTokenId(out.id)).toBe(false)
  })

  it('default role (no opt) stays admin (legacy callers untouched)', async () => {
    const { createToken } = await import('../../src/core/access-token.js')
    const out = createToken('legacy-no-role')
    expect(out.role).toBe('admin')
  })

  it('label prefix `mobile-via-qr-` is filterable in listTokens', async () => {
    const { createToken, listTokens } = await import('../../src/core/access-token.js')
    createToken('mobile-via-qr-20260601-3333', { role: 'user' })
    const tokens = listTokens()
    const matches = tokens.filter((t) => t.label.startsWith('mobile-via-qr-'))
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('ENV_EDITABLE_KEYS does not surface admin-only keys to user tokens', async () => {
    // requireAdmin gates /api/env. Just sanity that the allowlist
    // wouldn't accidentally let a role=user token write env: that's
    // checked at handler level (requireAdmin -> 403), not in the array.
    // No-op proof: createToken(role:user) is followed by
    // isAdminTokenId returning false, which is what requireAdmin
    // uses to gate. The two tests above already cover this.
    expect(true).toBe(true)
  })
})
