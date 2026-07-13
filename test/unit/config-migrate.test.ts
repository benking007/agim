import { describe, it, expect } from 'bun:test'
import type { Config } from '../../src/core/types'
import { migrateNativeAgentToggle } from '../../src/core/config-migrate'

function cfg(over: Partial<Config> = {}): Config {
  return {
    messengers: [],
    agents: [],
    defaultAgent: 'claude-code',
    ...over,
  } as Config
}

describe('migrateNativeAgentToggle', () => {
  it('is a no-op when the migration flag is already set', () => {
    const input = cfg({
      agents: ['codex'],
      nativeAgentToggleMigrated: true,
    })
    const { config, changed } = migrateNativeAgentToggle(input)
    expect(changed).toBe(false)
    expect(config.agents).toEqual(['codex'])
    expect(config).toBe(input)
  })

  it('adds native to a legacy non-empty list and sets the flag', () => {
    const { config, changed } = migrateNativeAgentToggle(
      cfg({ agents: ['codex', 'opencode'] }),
    )
    expect(changed).toBe(true)
    expect(config.agents).toEqual(['codex', 'opencode', 'native'])
    expect(config.nativeAgentToggleMigrated).toBe(true)
  })

  it('only sets the flag for empty agents (allow-all) without injecting native', () => {
    const { config, changed } = migrateNativeAgentToggle(cfg({ agents: [] }))
    expect(changed).toBe(true)
    expect(config.agents).toEqual([])
    expect(config.nativeAgentToggleMigrated).toBe(true)
  })

  it('does not duplicate native when already listed', () => {
    const { config, changed } = migrateNativeAgentToggle(
      cfg({ agents: ['native', 'codex'] }),
    )
    expect(changed).toBe(true)
    expect(config.agents).toEqual(['native', 'codex'])
    expect(config.nativeAgentToggleMigrated).toBe(true)
  })

  it('after migration, absence of native is preserved on later runs', () => {
    const first = migrateNativeAgentToggle(cfg({ agents: ['codex'] }))
    expect(first.config.agents).toContain('native')
    // Operator then disables native in the SPA:
    const afterDisable: Config = {
      ...first.config,
      agents: ['codex'],
    }
    const second = migrateNativeAgentToggle(afterDisable)
    expect(second.changed).toBe(false)
    expect(second.config.agents).toEqual(['codex'])
  })
})
