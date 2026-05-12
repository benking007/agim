import { describe, it, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { saveConfig } from '../../src/core/onboarding'
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
})
