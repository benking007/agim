// Unit tests for the webhook URL validator that gates Schedule.notify_url.
// Defense-in-depth against accidental misconfig and basic SSRF: we should
// only allow http(s) URLs to public hosts, and never to loopback / private
// ranges unless the operator explicitly opts in via env.

import { describe, it, expect, afterEach } from 'bun:test'
import { validateWebhookUrl, assertWebhookHostPublic } from '../../src/core/schedule'

const ENV_FLAG = 'AGIM_ALLOW_PRIVATE_WEBHOOKS'
const ORIGINAL = process.env[ENV_FLAG]

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[ENV_FLAG]
  else process.env[ENV_FLAG] = ORIGINAL
})

describe('validateWebhookUrl', () => {
  describe('protocol gate', () => {
    it('accepts http://', () => {
      const r = validateWebhookUrl('http://example.com/hook')
      expect(r.ok).toBe(true)
    })

    it('accepts https://', () => {
      const r = validateWebhookUrl('https://example.com/hook')
      expect(r.ok).toBe(true)
    })

    it('rejects file://', () => {
      const r = validateWebhookUrl('file:///etc/passwd')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/protocol/i)
    })

    it('rejects gopher://', () => {
      const r = validateWebhookUrl('gopher://example.com/')
      expect(r.ok).toBe(false)
    })

    it('rejects malformed URL', () => {
      const r = validateWebhookUrl('not-a-url')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/malformed/i)
    })
  })

  describe('private / loopback IPv4 block', () => {
    it.each([
      'http://127.0.0.1/',
      'http://127.10.20.30/',
      'http://10.0.0.1/',
      'http://10.255.255.255/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://169.254.169.254/',  // cloud metadata
      'http://0.0.0.0/',
      'http://100.64.0.1/',       // CGNAT
    ])('rejects %s', (url) => {
      const r = validateWebhookUrl(url)
      expect(r.ok).toBe(false)
    })

    it('does NOT reject 172.32.0.0 (just outside the private range)', () => {
      const r = validateWebhookUrl('http://172.32.0.1/')
      expect(r.ok).toBe(true)
    })

    it('does NOT reject 8.8.8.8 (public)', () => {
      const r = validateWebhookUrl('http://8.8.8.8/hook')
      expect(r.ok).toBe(true)
    })
  })

  describe('IPv6 / hostname block', () => {
    it('rejects localhost', () => {
      const r = validateWebhookUrl('http://localhost/hook')
      expect(r.ok).toBe(false)
    })

    it('rejects fe80:: link-local', () => {
      const r = validateWebhookUrl('http://fe80::1/hook')
      expect(r.ok).toBe(false)
    })

    it('rejects fc00:: ULA prefix', () => {
      const r = validateWebhookUrl('http://fc00::1/hook')
      expect(r.ok).toBe(false)
    })
  })

  describe('opt-in escape hatch', () => {
    it('AGIM_ALLOW_PRIVATE_WEBHOOKS=1 lets through 127.0.0.1', () => {
      process.env[ENV_FLAG] = '1'
      const r = validateWebhookUrl('http://127.0.0.1:9000/hook')
      expect(r.ok).toBe(true)
    })

    it('AGIM_ALLOW_PRIVATE_WEBHOOKS=1 still rejects file://', () => {
      process.env[ENV_FLAG] = '1'
      const r = validateWebhookUrl('file:///etc/passwd')
      expect(r.ok).toBe(false)
    })
  })

  // CR H2 — the lexical validateWebhookUrl only sees the (WHATWG-normalized)
  // host string, so a HOSTNAME that resolves to private space — DNS rebinding,
  // split-horizon, or an attacker domain whose A-record points at
  // 169.254.169.254 / 10.x / 127.x — passes it. assertWebhookHostPublic
  // resolves the host at fetch time and rejects whatever it lands on. That's
  // the "at-fetch-time guard tracked separately" the code comment referenced.
  describe('assertWebhookHostPublic (at-fetch-time DNS guard)', () => {
    it('a non-IP hostname passes the lexical check (only the DNS guard can judge it)', () => {
      // The lexical check can't know what evil.example resolves to.
      expect(validateWebhookUrl('http://evil.example/hook').ok).toBe(true)
    })

    it('rejects a literal loopback IP', async () => {
      expect((await assertWebhookHostPublic('127.0.0.1')).ok).toBe(false)
    })

    it('rejects a private RFC1918 literal', async () => {
      expect((await assertWebhookHostPublic('10.1.2.3')).ok).toBe(false)
    })

    it('rejects the cloud-metadata link-local address', async () => {
      expect((await assertWebhookHostPublic('169.254.169.254')).ok).toBe(false)
    })

    it('allows a public literal IP', async () => {
      expect((await assertWebhookHostPublic('8.8.8.8')).ok).toBe(true)
    })

    it('AGIM_ALLOW_PRIVATE_WEBHOOKS=1 bypasses the DNS guard', async () => {
      process.env[ENV_FLAG] = '1'
      expect((await assertWebhookHostPublic('127.0.0.1')).ok).toBe(true)
    })
  })
})
