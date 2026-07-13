import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  migrateNamingV2,
  migrateAgentIdNativeToAgim,
  migrateWorkspacesToTenants,
  migratePiSessionsDir,
  getTenantsFromConfig,
  normalizeAgentId,
  AGIM_AGENT_ID,
} from '../../src/core/naming-migrate.js'
import { canonicalizeToolName, expandToolNameList, toolNameVariants } from '../../src/core/llm/tool-names.js'

describe('tool-names', () => {
  test('canonicalizeToolName maps legacy native_* to agim_*', () => {
    expect(canonicalizeToolName('native_read_file')).toBe('agim_read_file')
    expect(canonicalizeToolName('agim_exec')).toBe('agim_exec')
    expect(canonicalizeToolName('mcp__agim__ask_user')).toBe('mcp__agim__ask_user')
  })

  test('expandToolNameList includes both spellings', () => {
    const set = expandToolNameList(['agim_exec', 'native_write_file'])
    expect(set.has('agim_exec')).toBe(true)
    expect(set.has('native_exec')).toBe(true)
    expect(set.has('agim_write_file')).toBe(true)
    expect(set.has('native_write_file')).toBe(true)
  })

  test('toolNameVariants returns pair', () => {
    expect(toolNameVariants('native_echo')).toEqual(['agim_echo', 'native_echo'])
  })
})

describe('naming-migrate', () => {
  test('normalizeAgentId', () => {
    expect(normalizeAgentId('native')).toBe(AGIM_AGENT_ID)
    expect(normalizeAgentId('agim')).toBe('agim')
    expect(normalizeAgentId('claude-code')).toBe('claude-code')
  })

  test('migrateAgentIdNativeToAgim rewrites config fields', () => {
    const { config, changed } = migrateAgentIdNativeToAgim({
      messengers: [],
      agents: ['claude-code', 'native'],
      defaultAgent: 'native',
      workspaces: [{ id: 't1', name: 'T', agents: ['native'] }],
    } as never)
    expect(changed).toBe(true)
    expect(config.defaultAgent).toBe('agim')
    expect(config.agents).toEqual(['claude-code', 'agim'])
    expect((config.workspaces as Array<{ agents: string[] }>)[0].agents).toEqual(['agim'])
    expect(config.agimAgentIdMigrated).toBe(true)
  })

  test('migrateWorkspacesToTenants copies workspaces', () => {
    const { config, changed } = migrateWorkspacesToTenants({
      messengers: [],
      agents: [],
      defaultAgent: 'agim',
      workspaces: [{ id: 't1', name: 'T', agents: ['agim'] }],
    } as never)
    expect(changed).toBe(true)
    expect(config.tenantsFieldMigrated).toBe(true)
    expect(config.tenants).toEqual([{ id: 't1', name: 'T', agents: ['agim'] }])
    expect(getTenantsFromConfig(config)).toHaveLength(1)
  })

  test('migrateNamingV2 is idempotent after flags', () => {
    const first = migrateNamingV2({
      messengers: [],
      agents: ['native'],
      defaultAgent: 'native',
      workspaces: [{ id: 't1', name: 'T', agents: ['native'] }],
    } as never)
    expect(first.changed).toBe(true)
    expect(first.config.defaultAgent).toBe('agim')
    const second = migrateNamingV2(first.config)
    // Flags set → no further persistence needed for tenants/id; may still be false
    expect(second.config.agimAgentIdMigrated).toBe(true)
    expect(second.config.tenantsFieldMigrated).toBe(true)
    expect(second.config.defaultAgent).toBe('agim')
  })

  test('migratePiSessionsDir renames legacy dir', () => {
    const home = join(tmpdir(), `agim-naming-${process.pid}-${Date.now()}`)
    mkdirSync(join(home, 'pi-sessions'), { recursive: true })
    writeFileSync(join(home, 'pi-sessions', 'x.json'), '{}')
    const target = migratePiSessionsDir(home)
    expect(target).toBe(join(home, 'agim-sessions'))
    expect(existsSync(join(home, 'agim-sessions', 'x.json'))).toBe(true)
    expect(existsSync(join(home, 'pi-sessions'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})
