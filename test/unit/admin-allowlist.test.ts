import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

// Disable the env-file fallback BEFORE importing admin-allowlist — otherwise
// readFileAdminUsers() picks up the operator's real ~/.agim/env on the dev
// box and pollutes tests that expect an empty allowlist.
process.env.IMHUB_ENV_FILE_PATH = ''

import { isAdmin, isAllowlistConfigured, denialMessage, _resetCache } from '../../src/core/admin-allowlist.js'

const originalEnv = process.env.IMHUB_ADMIN_USERS

function setEnv(v: string | undefined): void {
  if (v === undefined) delete process.env.IMHUB_ADMIN_USERS
  else process.env.IMHUB_ADMIN_USERS = v
  _resetCache()
}

describe('admin-allowlist', () => {
  beforeEach(() => { setEnv(undefined) })
  afterEach(() => { setEnv(originalEnv) })

  describe('isAllowlistConfigured', () => {
    it('returns false when env unset', () => {
      expect(isAllowlistConfigured()).toBe(false)
    })
    it('returns false on empty string / whitespace', () => {
      setEnv('')
      expect(isAllowlistConfigured()).toBe(false)
      setEnv('   ')
      expect(isAllowlistConfigured()).toBe(false)
    })
    it('returns true when set', () => {
      setEnv('telegram:123')
      expect(isAllowlistConfigured()).toBe(true)
    })
  })

  describe('isAdmin', () => {
    it('always denies when env unset', () => {
      expect(isAdmin('telegram', '123')).toBe(false)
      expect(isAdmin('wechat-ilink', 'wxid_abc')).toBe(false)
    })

    it('denies when env is set but user not listed', () => {
      setEnv('telegram:123,feishu:ou_xxx')
      expect(isAdmin('telegram', '456')).toBe(false)
      expect(isAdmin('discord', '123')).toBe(false)
    })

    it('allows matching platform:userId pair', () => {
      setEnv('telegram:123,wechat-ilink:wxid_abc')
      expect(isAdmin('telegram', '123')).toBe(true)
      expect(isAdmin('wechat-ilink', 'wxid_abc')).toBe(true)
    })

    it('platform is case-insensitive', () => {
      setEnv('Telegram:123')
      expect(isAdmin('telegram', '123')).toBe(true)
      expect(isAdmin('TELEGRAM', '123')).toBe(true)
    })

    it('userId is case-sensitive', () => {
      setEnv('telegram:UserA')
      expect(isAdmin('telegram', 'UserA')).toBe(true)
      expect(isAdmin('telegram', 'usera')).toBe(false)
    })

    it('denies when userId is empty', () => {
      setEnv('telegram:123')
      expect(isAdmin('telegram', '')).toBe(false)
      expect(isAdmin('telegram', undefined)).toBe(false)
    })

    it('skips malformed entries silently', () => {
      setEnv('telegram:123,broken,bad:,:also-bad,wechat-ilink:wxid')
      expect(isAdmin('telegram', '123')).toBe(true)
      expect(isAdmin('wechat-ilink', 'wxid')).toBe(true)
    })
  })

  describe('denialMessage', () => {
    it('points to /setup admin when no admins configured', () => {
      const msg = denialMessage('telegram', '12345')
      expect(msg).toContain('/setup admin')
      // user's id appears in the message so they can copy-paste it
      expect(msg).toContain('telegram:12345')
      // Don't leak IMHUB_ADMIN_USERS internals to end users
      expect(msg).not.toContain('IMHUB_ADMIN_USERS')
    })
    it('gives generic denial when allowlist set but user missing', () => {
      setEnv('telegram:other')
      const msg = denialMessage('telegram', '12345')
      expect(msg).toContain('没有权限')
      // Don't leak the current admin id back to non-admins
      expect(msg).not.toContain('other')
    })
  })
})
