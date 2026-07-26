// Unit tests for zod-based config validation

import { describe, it, expect } from 'bun:test'
import { validateConfig } from '../../src/core/config-schema'

describe('validateConfig', () => {
  it('accepts an empty object and fills defaults', () => {
    const result = validateConfig({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.messengers).toEqual([])
      expect(result.config.agents).toEqual([])
      expect(result.config.defaultAgent).toBe('agim')
    }
  })

  it('preserves passthrough fields', () => {
    const result = validateConfig({ defaultAgent: 'opencode', extraField: 42 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.defaultAgent).toBe('opencode')
      // passthrough() preserves unknown keys
      expect((result.config as Record<string, unknown>).extraField).toBe(42)
    }
  })

  it('rejects telegram config without botToken when telegram is enabled', () => {
    const result = validateConfig({
      messengers: ['telegram'],
      telegram: { channelId: 'xyz' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('telegram.botToken'))).toBe(true)
    }
  })

  it('allows partial telegram block when telegram is not enabled', () => {
    const result = validateConfig({
      messengers: ['dingtalk'],
      telegram: { channelId: 'xyz' },
      dingtalk: { clientId: 'id', clientSecret: 'secret' },
    })
    expect(result.ok).toBe(true)
  })

  it('allows dingtalk-only save with empty sibling messenger objects', () => {
    const result = validateConfig({
      messengers: ['dingtalk'],
      telegram: {},
      feishu: {},
      discord: {},
      dingtalk: { clientId: 'ding-id', clientSecret: 'ding-secret' },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects feishu config without secret when feishu is enabled', () => {
    const result = validateConfig({
      messengers: ['feishu'],
      feishu: { appId: 'app' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('feishu.appSecret'))).toBe(true)
    }
  })

  it('ignores legacy ACP config keys', () => {
    const result = validateConfig({
      acpAgents: [{ name: 'my-agent', endpoint: 'https://example.com' }],
      acpDiscoveryUrls: ['not-a-url'],
      acpPort: 99_999,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.config as Record<string, unknown>).acpAgents).toBeUndefined()
      expect((result.config as Record<string, unknown>).acpDiscoveryUrls).toBeUndefined()
      expect((result.config as Record<string, unknown>).acpPort).toBeUndefined()
    }
  })

  it('accepts a workspace config with rate limit', () => {
    const result = validateConfig({
      workspaces: [{
        id: 'team', agents: ['opencode'], members: ['alice'],
        rateLimit: { rate: 5, intervalSec: 60, burst: 10 },
      }],
    })
    expect(result.ok).toBe(true)
  })

  it('rejects negative rateLimit values', () => {
    const result = validateConfig({
      workspaces: [{
        id: 'team', agents: [],
        rateLimit: { rate: -1, intervalSec: 60, burst: 10 },
      }],
    })
    expect(result.ok).toBe(false)
  })

  it('preserves unrelated config when a nested field is invalid', () => {
    const result = validateConfig({
      messengers: ['dingtalk'],
      agents: ['claude-code'],
      defaultAgent: 'claude-code',
      dingtalk: { clientId: 'id', clientSecret: 'secret' },
      workspaces: [{
        id: 'team', agents: ['claude-code'],
        rateLimit: { rate: 0, intervalSec: 60, burst: 10 },
      }],
    })

    expect(result.ok).toBe(false)
    expect(result.config.messengers).toEqual(['dingtalk'])
    expect(result.config.agents).toEqual(['claude-code'])
    expect(result.config.defaultAgent).toBe('claude-code')
    expect(result.config.workspaces).toBeUndefined()
    expect((result.config as Record<string, unknown>).dingtalk).toEqual({
      clientId: 'id', clientSecret: 'secret',
    })
  })

  it('disables only the messenger whose required credentials are invalid', () => {
    const result = validateConfig({
      messengers: ['telegram', 'dingtalk'],
      agents: ['codex'],
      defaultAgent: 'codex',
      telegram: { channelId: 'missing-token' },
      dingtalk: { clientId: 'id', clientSecret: 'secret' },
    })

    expect(result.ok).toBe(false)
    expect(result.config.messengers).toEqual(['dingtalk'])
    expect(result.config.agents).toEqual(['codex'])
    expect(result.config.defaultAgent).toBe('codex')
    expect(result.config.telegram).toBeUndefined()
  })

  it('rejects non-integer port numbers', () => {
    const result = validateConfig({ webPort: -10 })
    expect(result.ok).toBe(false)
  })

  it('rejects ports outside the TCP range', () => {
    expect(validateConfig({ webPort: 65_536 }).ok).toBe(false)
  })

  it('returns structured error paths', () => {
    const result = validateConfig({ telegram: 'not-an-object' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('telegram')
    }
  })
})
