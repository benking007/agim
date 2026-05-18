// M-N17 — secrets-store split/merge round-trip + path manipulation.
//
// These tests don't touch the filesystem; loadSecrets / saveSecrets is
// covered by the surrounding onboarding integration. The split/merge
// pair is pure path-arithmetic on plain objects and is what carries
// the security guarantee — anything routed through `secrets` becomes
// a 0o600 file in production.

import { describe, it, expect } from 'bun:test'
import {
  splitConfig,
  mergeSecrets,
  listSensitivePathsInConfig,
  SENSITIVE_PATHS,
} from '../../src/core/secrets-store'

describe('splitConfig', () => {
  it('moves telegram.botToken out of public into secrets', () => {
    const { publicCfg, secrets } = splitConfig({
      messengers: ['telegram'],
      telegram: { botToken: 's3cret', channelId: 'chan1' },
    })
    expect((publicCfg.telegram as Record<string, unknown>).botToken).toBeUndefined()
    expect((publicCfg.telegram as Record<string, unknown>).channelId).toBe('chan1')
    expect((secrets.telegram as Record<string, unknown>).botToken).toBe('s3cret')
  })

  it('does not mutate the input', () => {
    const input = {
      telegram: { botToken: 'x' },
      feishu: { appId: 'a', appSecret: 'b' },
    }
    const before = JSON.parse(JSON.stringify(input))
    splitConfig(input)
    expect(input).toEqual(before)
  })

  it('handles multiple sensitive paths at once', () => {
    const { publicCfg, secrets } = splitConfig({
      telegram: { botToken: 't', channelId: 'c' },
      feishu: { appId: 'a', appSecret: 's' },
      discord: { botToken: 'd', allowedGuilds: ['g'] },
    })
    expect((publicCfg.telegram as Record<string, unknown>).botToken).toBeUndefined()
    expect((publicCfg.feishu as Record<string, unknown>).appSecret).toBeUndefined()
    expect((publicCfg.discord as Record<string, unknown>).botToken).toBeUndefined()
    // Non-sensitive sibling fields stay public.
    expect((publicCfg.feishu as Record<string, unknown>).appId).toBe('a')
    expect((publicCfg.discord as Record<string, unknown>).allowedGuilds).toEqual(['g'])
    // All three tokens land in secrets.
    expect((secrets.telegram as Record<string, unknown>).botToken).toBe('t')
    expect((secrets.feishu as Record<string, unknown>).appSecret).toBe('s')
    expect((secrets.discord as Record<string, unknown>).botToken).toBe('d')
  })

  it('emits empty secrets when none of the paths are populated', () => {
    const { publicCfg, secrets } = splitConfig({
      messengers: ['wechat'],
      defaultAgent: 'claude-code',
    })
    expect(Object.keys(secrets)).toHaveLength(0)
    expect(publicCfg.messengers).toEqual(['wechat'])
  })

  it('omits a sensitive path whose value is undefined', () => {
    const { secrets } = splitConfig({ telegram: { channelId: 'c' } })
    // botToken absent → secrets must not contain a stub entry for it.
    expect(secrets.telegram).toBeUndefined()
  })
})

describe('mergeSecrets', () => {
  it('overlays a secrets-only field onto a public config', () => {
    const merged = mergeSecrets(
      { telegram: { channelId: 'c' } },
      { telegram: { botToken: 's3cret' } },
    )
    expect((merged.telegram as Record<string, unknown>).botToken).toBe('s3cret')
    expect((merged.telegram as Record<string, unknown>).channelId).toBe('c')
  })

  it('does not introduce keys not listed in SENSITIVE_PATHS', () => {
    const merged = mergeSecrets(
      {},
      // Secrets file is operator-edited; an unknown key must not silently
      // overlay onto the loaded config.
      { something_unknown: 'should-not-appear' } as Record<string, unknown>,
    )
    expect((merged as Record<string, unknown>).something_unknown).toBeUndefined()
  })

  it('round-trip: split → merge → original', () => {
    const original = {
      messengers: ['telegram', 'feishu'],
      defaultAgent: 'claude-code',
      telegram: { botToken: 't', channelId: 'c' },
      feishu: { appId: 'a', appSecret: 's' },
    }
    const { publicCfg, secrets } = splitConfig(original)
    const back = mergeSecrets(publicCfg, secrets)
    expect(back).toEqual(original)
  })
})

describe('listSensitivePathsInConfig', () => {
  it('reports populated sensitive paths', () => {
    const paths = listSensitivePathsInConfig({
      telegram: { botToken: 't' },
      feishu: { appId: 'a' },              // appSecret absent
      discord: { botToken: 'd' },
    })
    expect(paths.sort()).toEqual(['discord.botToken', 'telegram.botToken'].sort())
  })

  it('skips empty strings as well as undefined', () => {
    const paths = listSensitivePathsInConfig({
      telegram: { botToken: '' },
      discord: { botToken: 'd' },
    })
    expect(paths).toEqual(['discord.botToken'])
  })

  it('matches SENSITIVE_PATHS as a complete list (regression guard)', () => {
    // Snapshot test: when SENSITIVE_PATHS gains an entry, a reviewer has
    // to either update this assertion or notice that they expanded the
    // migration surface — both desirable.
    expect(SENSITIVE_PATHS).toEqual([
      'telegram.botToken',
      'feishu.appSecret',
      'discord.botToken',
    ])
  })
})
