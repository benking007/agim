import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  isSenderAllowed,
  isSenderAllowlistConfigured,
  senderDenialMessage,
  _resetCache,
} from '../../src/core/sender-allowlist.js'

const ORIG = process.env.IMHUB_ALLOWED_USERS

function setEnv(v: string | undefined): void {
  if (v === undefined) delete process.env.IMHUB_ALLOWED_USERS
  else process.env.IMHUB_ALLOWED_USERS = v
  _resetCache()
}

describe('sender-allowlist', () => {
  beforeEach(() => setEnv(undefined))
  afterEach(() => setEnv(ORIG))

  describe('default (env unset)', () => {
    it('isSenderAllowlistConfigured returns false', () => {
      expect(isSenderAllowlistConfigured()).toBe(false)
    })
    it('isSenderAllowed returns true for anyone', () => {
      expect(isSenderAllowed('telegram', '123')).toBe(true)
      expect(isSenderAllowed('wechat-ilink', 'wxid_abc')).toBe(true)
      // Even with empty/undefined userId, when unconfigured we pass.
      expect(isSenderAllowed('discord', undefined)).toBe(true)
    })
  })

  describe('wildcard "*" ', () => {
    it('treats env="*" as open (configured but open)', () => {
      setEnv('*')
      expect(isSenderAllowlistConfigured()).toBe(true)
      expect(isSenderAllowed('telegram', 'anything')).toBe(true)
    })
    it('treats env="*,foo:bar" as still wildcard', () => {
      setEnv('*, telegram:123')
      expect(isSenderAllowed('discord', '999')).toBe(true)
    })
  })

  describe('explicit allowlist', () => {
    it('exact platform:userId match passes', () => {
      setEnv('telegram:8754479311, wechat-ilink:wxid_abc')
      expect(isSenderAllowed('telegram', '8754479311')).toBe(true)
      expect(isSenderAllowed('wechat-ilink', 'wxid_abc')).toBe(true)
    })
    it('mismatch fails', () => {
      setEnv('telegram:8754479311')
      expect(isSenderAllowed('telegram', '999')).toBe(false)
      expect(isSenderAllowed('discord', '8754479311')).toBe(false)
    })
    it('platform is case-insensitive', () => {
      setEnv('Telegram:abc')
      expect(isSenderAllowed('telegram', 'abc')).toBe(true)
      expect(isSenderAllowed('TELEGRAM', 'abc')).toBe(true)
    })
    it('userId is case-sensitive', () => {
      setEnv('telegram:UserA')
      expect(isSenderAllowed('telegram', 'UserA')).toBe(true)
      expect(isSenderAllowed('telegram', 'usera')).toBe(false)
    })
    it('empty/undefined userId denied when configured', () => {
      setEnv('telegram:123')
      expect(isSenderAllowed('telegram', '')).toBe(false)
      expect(isSenderAllowed('telegram', undefined)).toBe(false)
    })
    it('skips malformed entries silently', () => {
      setEnv('telegram:123,broken,:bad,bad:,wechat-ilink:wxid')
      expect(isSenderAllowed('telegram', '123')).toBe(true)
      expect(isSenderAllowed('wechat-ilink', 'wxid')).toBe(true)
    })
  })

  describe('senderDenialMessage', () => {
    it('includes the user id so they can copy-paste', () => {
      const msg = senderDenialMessage('telegram', '8754479311')
      expect(msg).toContain('telegram:8754479311')
      expect(msg).toContain('not on the allowlist')
    })
    it('handles missing userId', () => {
      const msg = senderDenialMessage('discord', undefined)
      expect(msg).toContain('discord:<unknown>')
    })
    // Don't leak the existing allowlist contents to non-allowed users.
    it('does not include IMHUB_ALLOWED_USERS literal', () => {
      const msg = senderDenialMessage('telegram', '123')
      expect(msg).not.toContain('IMHUB_ALLOWED_USERS')
    })
  })
})
