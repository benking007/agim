import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ensureBootstrapTokenIfNeeded,
  consumeBootstrapToken,
  BOOTSTRAP_TOKEN_FILE,
} from '../../src/core/admin-bootstrap.js'
import {
  isAdmin,
  isAllowlistConfigured,
  listAdmins,
  promoteAdmin,
  _resetCache,
} from '../../src/core/admin-allowlist.js'

const originalEnv = process.env.IMHUB_ADMIN_USERS

function clean(): void {
  try { unlinkSync(BOOTSTRAP_TOKEN_FILE) } catch { /* ok */ }
}

describe('admin-bootstrap', () => {
  beforeEach(() => {
    delete process.env.IMHUB_ADMIN_USERS
    _resetCache()
    clean()
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.IMHUB_ADMIN_USERS
    else process.env.IMHUB_ADMIN_USERS = originalEnv
    _resetCache()
    clean()
  })

  it('generates token + writes file when no admin set', () => {
    const token = ensureBootstrapTokenIfNeeded()
    expect(token).not.toBeNull()
    expect(token!.length).toBeGreaterThan(10)
    expect(existsSync(BOOTSTRAP_TOKEN_FILE)).toBe(true)
    const onDisk = readFileSync(BOOTSTRAP_TOKEN_FILE, 'utf-8').trim()
    expect(onDisk).toBe(token)
  })

  it('returns null + cleans stale file when admins already configured', () => {
    process.env.IMHUB_ADMIN_USERS = 'telegram:123'
    _resetCache()
    // Plant a stale token file
    mkdirSync(dirname(BOOTSTRAP_TOKEN_FILE), { recursive: true })
    writeFileSync(BOOTSTRAP_TOKEN_FILE, 'STALE-TOKEN')
    const token = ensureBootstrapTokenIfNeeded()
    expect(token).toBeNull()
    expect(existsSync(BOOTSTRAP_TOKEN_FILE)).toBe(false)
  })

  it('consumeBootstrapToken promotes + unlinks on match', async () => {
    const token = ensureBootstrapTokenIfNeeded()
    expect(token).not.toBeNull()
    expect(isAdmin('telegram', '12345')).toBe(false)
    const result = await consumeBootstrapToken(token!, 'telegram', '12345')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.alreadyAdmin).toBe(false)
    expect(isAdmin('telegram', '12345')).toBe(true)
    expect(existsSync(BOOTSTRAP_TOKEN_FILE)).toBe(false)
  })

  it('consumeBootstrapToken rejects mismatch (file remains)', async () => {
    ensureBootstrapTokenIfNeeded()
    const result = await consumeBootstrapToken('WRONG-TOKEN', 'telegram', '12345')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('mismatch')
    expect(isAdmin('telegram', '12345')).toBe(false)
    expect(existsSync(BOOTSTRAP_TOKEN_FILE)).toBe(true)
  })

  it('consumeBootstrapToken rejects when no token file exists', async () => {
    // beforeEach already cleaned the file
    const result = await consumeBootstrapToken('ANY-TOKEN', 'telegram', '12345')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_token_file')
  })

  it('consumeBootstrapToken rejects missing userId', async () => {
    ensureBootstrapTokenIfNeeded()
    const result = await consumeBootstrapToken('ANYTHING', 'telegram', '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_user_id')
  })

  it('promoteAdmin survives within the same process', async () => {
    expect(isAllowlistConfigured()).toBe(false)
    await promoteAdmin('telegram', '123')
    expect(isAllowlistConfigured()).toBe(true)
    expect(isAdmin('telegram', '123')).toBe(true)
    expect(listAdmins()).toEqual([{ platform: 'telegram', userId: '123' }])
  })

  it('promoteAdmin is idempotent', async () => {
    const a = await promoteAdmin('telegram', '123')
    const b = await promoteAdmin('telegram', '123')
    expect(a).toBe(true)
    expect(b).toBe(false)
    expect(listAdmins()).toHaveLength(1)
  })
})
