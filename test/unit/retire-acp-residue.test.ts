import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pin AGIM_HOME before importing modules that capture CONFIG_FILE / ENV_FILE.
const DIR = mkdtempSync(join(tmpdir(), 'agim-retire-acp-'))
process.env.AGIM_HOME = DIR

const { purgeRetiredAcpResidue } = await import('../../src/cli-ui/retire-acp-residue.js')
const { CONFIG_FILE } = await import('../../src/core/config-store.js')
const { ENV_FILE } = await import('../../src/cli-ui/env-file.js')

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('purgeRetiredAcpResidue', () => {
  it('removes retired ACP keys from config.json and env', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      agents: ['agim'],
      defaultAgent: 'agim',
      acpPort: 9090,
      acpAgents: [],
    }, null, 2))
    writeFileSync(ENV_FILE, [
      'AGIM_ACP_BIND=0.0.0.0',
      'AGIM_ENABLE_REMOTE_AGENT=1',
      'AGIM_WEB_AUTH=off',
    ].join('\n') + '\n')

    const result = await purgeRetiredAcpResidue()

    expect(result.configKeysRemoved).toContain('acpPort')
    expect(result.configKeysRemoved).toContain('acpAgents')
    expect(result.envKeysRemoved).toContain('AGIM_ACP_BIND')
    expect(result.envKeysRemoved).toContain('AGIM_ENABLE_REMOTE_AGENT')

    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    expect(cfg.acpPort).toBeUndefined()
    expect(cfg.acpAgents).toBeUndefined()
    expect(cfg.agents).toEqual(['agim'])

    const env = readFileSync(ENV_FILE, 'utf-8')
    expect(env).not.toContain('AGIM_ACP_BIND')
    expect(env).not.toContain('AGIM_ENABLE_REMOTE_AGENT')
    expect(env).toContain('AGIM_WEB_AUTH=off')
  })

  it('is a no-op when nothing retired remains', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      agents: ['agim'],
      defaultAgent: 'agim',
      webPort: 3000,
    }, null, 2))
    writeFileSync(ENV_FILE, 'AGIM_WEB_AUTH=off\n')

    const result = await purgeRetiredAcpResidue()
    expect(result.configKeysRemoved).toEqual([])
    expect(result.envKeysRemoved).toEqual([])
  })
})
