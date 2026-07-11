import { describe, it, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { saveConfig, saveConfigChanges } from '../../src/core/onboarding'
import { AGIM_HOME } from '../../src/core/agim-paths'

const CONFIG_FILE = join(AGIM_HOME, 'config.json')

describe('onboarding config persistence', () => {
  it('stores config.json with owner-only permissions', async () => {
    const hadOriginal = existsSync(CONFIG_FILE)
    const original = hadOriginal ? await readFile(CONFIG_FILE) : undefined
    const originalMode = hadOriginal ? (await stat(CONFIG_FILE)).mode & 0o777 : undefined

    try {
      if (hadOriginal) {
        await chmod(CONFIG_FILE, 0o644)
      }
      await saveConfig({ messengers: [], agents: [], defaultAgent: 'claude-code' })
      const mode = (await stat(CONFIG_FILE)).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      if (hadOriginal && original) {
        const restoreMode = originalMode ?? 0o600
        await writeFile(CONFIG_FILE, original, { mode: restoreMode })
        await chmod(CONFIG_FILE, restoreMode)
      } else {
        await rm(CONFIG_FILE, { force: true })
      }
    }
  })

  it('persists wizard changes without overwriting unrelated concurrent updates', async () => {
    const hadOriginal = existsSync(CONFIG_FILE)
    const original = hadOriginal ? await readFile(CONFIG_FILE) : undefined
    const base = {
      messengers: [],
      agents: ['claude-code', 'codex'],
      defaultAgent: 'claude-code',
    }

    try {
      await saveConfig({
        ...base,
        mcpServers: [{ name: 'added-while-wizard-open', command: '/bin/echo' }],
      })
      const stored = await saveConfigChanges(base, { ...base, defaultAgent: 'codex' })

      expect(stored.defaultAgent).toBe('codex')
      expect(stored.mcpServers).toEqual([
        { name: 'added-while-wizard-open', command: '/bin/echo' },
      ])
    } finally {
      if (hadOriginal && original) await writeFile(CONFIG_FILE, original, { mode: 0o600 })
      else await rm(CONFIG_FILE, { force: true })
    }
  })
})
