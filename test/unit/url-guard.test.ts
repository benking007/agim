// R9 — SSRF guard for ACP operator-supplied URLs. The unit covers the
// six refusal categories + the success path, plus the IPv4-mapped-IPv6
// quirk that bit us on the v4 prototype.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  assertSafeAcpUrl,
  isPrivateAddr,
  UnsafeAcpUrlError,
} from '../../src/plugins/agents/acp/url-guard'

describe('isPrivateAddr (IPv4)', () => {
  it.each([
    ['127.0.0.1'],
    ['127.255.255.254'],
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['192.168.1.1'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['169.254.169.254'], // AWS/GCP metadata
    ['0.0.0.0'],
  ])('rejects %s', (ip) => {
    expect(isPrivateAddr(ip, 4)).toBe(true)
  })

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['172.32.0.1'], // just outside RFC1918 range
    ['172.15.255.255'],
    ['168.254.1.1'], // not link-local (off by one)
  ])('accepts %s', (ip) => {
    expect(isPrivateAddr(ip, 4)).toBe(false)
  })
})

describe('isPrivateAddr (IPv6)', () => {
  it.each([
    ['::1'],
    ['::'],
    ['fc00::1'],
    ['fd12:3456:789a::1'],
    ['fe80::1'],
    ['feaf::1'],
    ['::ffff:127.0.0.1'], // v4-mapped loopback
    ['::ffff:10.0.0.1'],  // v4-mapped RFC1918
  ])('rejects %s', (ip) => {
    expect(isPrivateAddr(ip, 6)).toBe(true)
  })

  it.each([
    ['2001:db8::1'],
    ['2606:4700:4700::1111'], // Cloudflare DNS v6
    ['fec0::1'],              // deprecated site-local — explicitly NOT in our list (pre-2004 RFC); accept
  ])('accepts %s', (ip) => {
    expect(isPrivateAddr(ip, 6)).toBe(false)
  })
})

describe('assertSafeAcpUrl', () => {
  const ALLOW = 'IMHUB_ACP_ALLOW_LOOPBACK'
  const orig = process.env[ALLOW]
  beforeEach(() => { delete process.env[ALLOW] })
  afterEach(() => {
    if (orig === undefined) delete process.env[ALLOW]
    else process.env[ALLOW] = orig
  })

  it('rejects non-http schemes', async () => {
    await expect(assertSafeAcpUrl('file:///etc/passwd', { forwardsCredentials: false }))
      .rejects.toThrow(UnsafeAcpUrlError)
    await expect(assertSafeAcpUrl('ftp://example.com', { forwardsCredentials: false }))
      .rejects.toThrow(/scheme/i)
    await expect(assertSafeAcpUrl('javascript:alert(1)', { forwardsCredentials: false }))
      .rejects.toThrow(UnsafeAcpUrlError)
  })

  it('rejects http when credentials would be forwarded', async () => {
    // 8.8.8.8 resolves to public — without forwardsCredentials this
    // would pass. With creds, the http variant fails.
    try {
      await assertSafeAcpUrl('http://8.8.8.8/agent/card', { forwardsCredentials: true })
      throw new Error('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeAcpUrlError)
      expect((err as UnsafeAcpUrlError).reason).toBe('plaintext_credentials')
    }
  })

  it('rejects URLs with embedded userinfo', async () => {
    await expect(assertSafeAcpUrl('https://user:pass@example.com/', { forwardsCredentials: false }))
      .rejects.toThrow(/userinfo|embedded/i)
  })

  it('rejects RFC1918 hostnames after DNS resolve', async () => {
    // Literal IPs short-circuit DNS to the same value, so 192.168.x → fail.
    try {
      await assertSafeAcpUrl('http://192.168.1.1/.well-known/acp', { forwardsCredentials: false })
      throw new Error('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeAcpUrlError)
      expect((err as UnsafeAcpUrlError).reason).toBe('private_address')
    }
  })

  it('rejects 169.254.169.254 (cloud metadata)', async () => {
    try {
      await assertSafeAcpUrl('http://169.254.169.254/latest/meta-data/', { forwardsCredentials: false })
      throw new Error('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeAcpUrlError)
      expect((err as UnsafeAcpUrlError).reason).toBe('private_address')
    }
  })

  it('rejects loopback by default', async () => {
    try {
      await assertSafeAcpUrl('http://127.0.0.1:6379/.well-known/acp', { forwardsCredentials: false })
      throw new Error('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeAcpUrlError)
      expect((err as UnsafeAcpUrlError).reason).toBe('private_address')
    }
  })

  it('allows loopback when IMHUB_ACP_ALLOW_LOOPBACK=1 (dev path)', async () => {
    process.env[ALLOW] = '1'
    const u = await assertSafeAcpUrl('http://127.0.0.1:8080/agent/card', { forwardsCredentials: false })
    expect(u.host).toBe('127.0.0.1:8080')
  })

  it('accepts a public https URL without credentials', async () => {
    const u = await assertSafeAcpUrl('https://example.com/.well-known/acp', { forwardsCredentials: false })
    expect(u.hostname).toBe('example.com')
  })

  it('accepts a public https URL when credentials are forwarded', async () => {
    const u = await assertSafeAcpUrl('https://example.com/agent/card', { forwardsCredentials: true })
    expect(u.protocol).toBe('https:')
  })

  it('garbage input throws url_parse', async () => {
    try {
      await assertSafeAcpUrl('not a url', { forwardsCredentials: false })
      throw new Error('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeAcpUrlError)
      expect((err as UnsafeAcpUrlError).reason).toBe('url_parse')
    }
  })
})
