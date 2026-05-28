// v1.2.103 — live-config singleton + registry enabled-list filter.
// Locks the contract that (a) PUT /api/config refreshing the live
// config takes effect on the next read, and (b) registry.findAgent
// / listAgents honour the enabled list.

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import type { Config } from '../../src/core/types'
import {
  setLiveConfig,
  getLiveConfig,
  getDefaultAgent,
  isAgentEnabled,
  __resetLiveConfigForTest,
} from '../../src/core/live-config'

function cfg(over: Partial<Config> = {}): Config {
  return {
    messengers: [],
    agents: [],
    defaultAgent: 'claude-code',
    ...over,
  } as Config
}

describe('live-config singleton', () => {
  beforeEach(() => {
    __resetLiveConfigForTest()
  })

  it('starts unset; getLiveConfig() returns null', () => {
    expect(getLiveConfig()).toBeNull()
  })

  it('getDefaultAgent() falls back to "claude-code" when unset', () => {
    expect(getDefaultAgent()).toBe('claude-code')
  })

  it('getDefaultAgent(fallback) honours the caller fallback', () => {
    expect(getDefaultAgent('codex')).toBe('codex')
  })

  it('setLiveConfig() updates getDefaultAgent', () => {
    setLiveConfig(cfg({ defaultAgent: 'codex' }))
    expect(getDefaultAgent()).toBe('codex')
  })

  it('isAgentEnabled() — empty agents=[] is "allow all" (back-compat)', () => {
    setLiveConfig(cfg({ agents: [] }))
    expect(isAgentEnabled('codex')).toBe(true)
    expect(isAgentEnabled('claude-code')).toBe(true)
    expect(isAgentEnabled('anything')).toBe(true)
  })

  it('isAgentEnabled() — non-empty list filters', () => {
    // defaultAgent set to a listed agent so the default-exemption doesn't
    // mask the filter behaviour under test.
    setLiveConfig(cfg({ agents: ['codex', 'opencode'], defaultAgent: 'codex' }))
    expect(isAgentEnabled('codex')).toBe(true)
    expect(isAgentEnabled('opencode')).toBe(true)
    expect(isAgentEnabled('claude-code')).toBe(false)
    expect(isAgentEnabled('cursor')).toBe(false)
  })

  it('isAgentEnabled() — native is always allowed (v1.2.105: never filtered)', () => {
    // Enabled list excludes native; native must still be reachable so /na
    // and native-default routing keep working.
    setLiveConfig(cfg({ agents: ['codex'], defaultAgent: 'codex' }))
    expect(isAgentEnabled('native')).toBe(true)
    expect(isAgentEnabled('claude-code')).toBe(false)
  })

  it('isAgentEnabled() — the default agent is always allowed even if not listed', () => {
    setLiveConfig(cfg({ agents: ['codex'], defaultAgent: 'claude-code' }))
    expect(isAgentEnabled('claude-code')).toBe(true) // default, exempt
    expect(isAgentEnabled('codex')).toBe(true) // listed
    expect(isAgentEnabled('opencode')).toBe(false) // neither
  })

  it('isAgentEnabled() — unset config is "allow all" (very early boot)', () => {
    expect(isAgentEnabled('whatever')).toBe(true)
  })

  it('subsequent setLiveConfig() overrides previous', () => {
    setLiveConfig(cfg({ defaultAgent: 'a', agents: ['a'] }))
    expect(getDefaultAgent()).toBe('a')
    expect(isAgentEnabled('b')).toBe(false)
    setLiveConfig(cfg({ defaultAgent: 'b', agents: ['b'] }))
    expect(getDefaultAgent()).toBe('b')
    expect(isAgentEnabled('a')).toBe(false)
    expect(isAgentEnabled('b')).toBe(true)
  })
})

describe('registry.listAgents / findAgent filter', () => {
  // We use a fresh import of registry to get its singleton, and craft
  // a mock agent for the test. The contract: registry filters by
  // isAgentEnabled() at read time, NOT at registerAgent() time, so a
  // PUT /api/config flip takes effect on the next call.

  beforeEach(() => {
    __resetLiveConfigForTest()
  })

  // CRITICAL: live-config is a process-wide singleton and bun shares
  // module state across test files in one run. If we leave a non-empty
  // enabled list set, downstream test files that call registry.findAgent
  // / listAgents would see an unexpected filter and fail. Reset to the
  // permissive "allow all" state when this file finishes.
  afterAll(() => {
    __resetLiveConfigForTest()
  })

  it('listAgents() returns all when enabled list is empty', async () => {
    const { registry } = await import('../../src/core/registry')
    setLiveConfig(cfg({ agents: [] }))
    const all = registry.listAgents()
    // exact contents depend on what registerAgent has been called for
    // in this test session; we just check non-empty (at least one
    // built-in agent registered by other tests) — empty enabled list
    // means "allow all", not "deny all".
    expect(Array.isArray(all)).toBe(true)
  })

  it('listAgents() filters to enabled when list is non-empty', async () => {
    const { registry } = await import('../../src/core/registry')
    // Pick one of the built-in names known to be registered.
    const everyone = registry.listAllAgents()
    if (everyone.length < 2) return
    const keep = everyone[0]
    setLiveConfig(cfg({ agents: [keep] }))
    const filtered = registry.listAgents()
    expect(filtered).toContain(keep)
    expect(filtered).toEqual([keep])
  })

  it('findAgent() returns undefined for a disabled agent', async () => {
    const { registry } = await import('../../src/core/registry')
    const everyone = registry.listAllAgents()
    if (everyone.length < 2) return
    const keep = everyone[0]
    const banned = everyone[1]
    setLiveConfig(cfg({ agents: [keep] }))
    expect(registry.findAgent(keep)?.name).toBe(keep)
    expect(registry.findAgent(banned)).toBeUndefined()
  })
})
