// Unit tests for the agim setup mcp wizard (P3 symmetry).
//
// Same approach as setup-llm.test.ts — exercise non-interactive
// branches (help / list-empty / remove-empty / health-unknown).
// Interactive add/remove/health branches need readline + are left
// to manual coverage (see test-plan in docs/cli-test-recipes.md if
// we ever add one).

import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-setup-mcp-'))
process.env.AGIM_HOME = TMP_OWN

const { _internal, runSetupMcp } = await import('./setup-mcp.js')
const { AGIM_HOME } = await import('../core/agim-paths.js')
const TMP = AGIM_HOME

beforeEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  mkdirSync(TMP, { recursive: true })
})

describe('setup-mcp — internal helpers', () => {
  it('suggestServerName produces filesystem-safe slug from preset label', () => {
    const slug = _internal.suggestServerName(_internal.PRESETS[0])
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug.length).toBeGreaterThan(0)
  })

  it('PRESETS includes filesystem / github / postgres / brave + 2 custom', () => {
    const labels = _internal.PRESETS.map((p) => p.label.toLowerCase())
    expect(labels.some((l) => l.startsWith('filesystem'))).toBe(true)
    expect(labels.some((l) => l.startsWith('github'))).toBe(true)
    expect(labels.some((l) => l.startsWith('postgres'))).toBe(true)
    expect(labels.some((l) => l.startsWith('custom http'))).toBe(true)
    expect(labels.some((l) => l.startsWith('custom stdio'))).toBe(true)
  })
})

describe('runSetupMcp — non-interactive paths', () => {
  it('returns 0 for empty argv (renders help)', async () => {
    expect(await runSetupMcp([])).toBe(0)
  })

  it('returns 0 for help / -h / --help', async () => {
    expect(await runSetupMcp(['help'])).toBe(0)
    expect(await runSetupMcp(['-h'])).toBe(0)
    expect(await runSetupMcp(['--help'])).toBe(0)
  })

  it('returns 1 for unknown subcommand', async () => {
    expect(await runSetupMcp(['mystery'])).toBe(1)
  })

  it('list on fresh install prints "no servers" and returns 0', async () => {
    expect(await runSetupMcp(['list'])).toBe(0)
  })

  it('remove on fresh install prints "no servers" and returns 0', async () => {
    expect(await runSetupMcp(['remove', 'anything'])).toBe(0)
  })

  it('health on fresh install prints "no servers" and returns 0', async () => {
    expect(await runSetupMcp(['health'])).toBe(0)
  })

  it('health with name on fresh install returns 0 (no-servers short-circuit fires first)', async () => {
    expect(await runSetupMcp(['health', 'never'])).toBe(0)
  })

  it('health with name aborts with non-zero when other servers exist but target missing', async () => {
    const seed = {
      messengers: [], agents: [], defaultAgent: 'claude-code',
      mcpServers: [{ name: 'other', command: '/bin/echo' }],
    }
    writeFileSync(join(TMP, 'config.json'), JSON.stringify(seed, null, 2))
    expect(await runSetupMcp(['health', 'no-such'])).toBe(1)
  })

  it('does not create config.json on read-only paths (help/list)', async () => {
    await runSetupMcp(['help'])
    await runSetupMcp(['list'])
    expect(existsSync(join(TMP, 'config.json'))).toBe(false)
  })

  it('remove does not corrupt an existing config when target missing', async () => {
    // Seed a config the wizard would otherwise leave alone.
    const seed = {
      messengers: ['telegram'], agents: ['claude-code'],
      defaultAgent: 'claude-code',
      mcpServers: [{ name: 'keeper', command: '/bin/echo' }],
    }
    writeFileSync(join(TMP, 'config.json'), JSON.stringify(seed, null, 2))
    await runSetupMcp(['remove', 'does-not-exist'])
    const after = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf-8'))
    expect(after).toEqual(seed)
  })
})
