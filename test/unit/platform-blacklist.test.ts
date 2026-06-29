import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  parsePlatformBlacklist,
  isPlatformBlacklisted,
  getPlatformBlacklist,
} from '../../src/core/registry.js'

const ORIG = process.env.AGIM_PLATFORM_BLACKLIST

function setEnv(v: string | undefined): void {
  if (v === undefined) delete process.env.AGIM_PLATFORM_BLACKLIST
  else process.env.AGIM_PLATFORM_BLACKLIST = v
}

describe('platform blacklist (v1.2.69)', () => {
  beforeEach(() => setEnv(undefined))
  afterEach(() => setEnv(ORIG))

  describe('parsePlatformBlacklist', () => {
    it('returns empty Set for undefined / empty / whitespace', () => {
      expect(parsePlatformBlacklist(undefined).size).toBe(0)
      expect(parsePlatformBlacklist('').size).toBe(0)
      expect(parsePlatformBlacklist('   ').size).toBe(0)
    })

    it('parses comma-separated entries case-insensitively', () => {
      const s = parsePlatformBlacklist('Telegram, DISCORD,feishu')
      expect(s.has('telegram')).toBe(true)
      expect(s.has('discord')).toBe(true)
      expect(s.has('feishu')).toBe(true)
    })

    it('expands wechat ⇔ wechat-ilink alias both directions', () => {
      const s1 = parsePlatformBlacklist('wechat')
      expect(s1.has('wechat')).toBe(true)
      expect(s1.has('wechat-ilink')).toBe(true)
      const s2 = parsePlatformBlacklist('wechat-ilink')
      expect(s2.has('wechat')).toBe(true)
      expect(s2.has('wechat-ilink')).toBe(true)
    })

    it('does NOT alias-expand non-wechat ids', () => {
      const s = parsePlatformBlacklist('telegram')
      expect(s.has('telegram')).toBe(true)
      expect(s.size).toBe(1)
    })
  })

  describe('isPlatformBlacklisted', () => {
    it('default (env unset): every platform allowed', () => {
      expect(isPlatformBlacklisted('telegram')).toBe(false)
      expect(isPlatformBlacklisted('wechat-ilink')).toBe(false)
      expect(isPlatformBlacklisted('anything')).toBe(false)
    })

    it('lists block exact match', () => {
      setEnv('telegram')
      expect(isPlatformBlacklisted('telegram')).toBe(true)
      expect(isPlatformBlacklisted('discord')).toBe(false)
    })

    it('wechat alias works for either form', () => {
      setEnv('wechat')
      expect(isPlatformBlacklisted('wechat-ilink')).toBe(true)
      setEnv('wechat-ilink')
      expect(isPlatformBlacklisted('wechat')).toBe(true)
    })

    it('hot env update re-parses on next call', () => {
      setEnv('telegram')
      expect(isPlatformBlacklisted('telegram')).toBe(true)
      setEnv('discord')
      expect(isPlatformBlacklisted('telegram')).toBe(false)
      expect(isPlatformBlacklisted('discord')).toBe(true)
    })

    it('platform check is case-insensitive', () => {
      setEnv('TELEGRAM')
      expect(isPlatformBlacklisted('telegram')).toBe(true)
      expect(isPlatformBlacklisted('Telegram')).toBe(true)
    })
  })

  describe('getPlatformBlacklist', () => {
    it('returns sorted-ish array snapshot', () => {
      setEnv('telegram,discord')
      const list = getPlatformBlacklist()
      expect(list.includes('telegram')).toBe(true)
      expect(list.includes('discord')).toBe(true)
    })

    it('empty array when unset', () => {
      expect(getPlatformBlacklist()).toEqual([])
    })
  })
})
