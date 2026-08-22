import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-sync-preset-'))
process.env.AGIM_HOME = TMP_OWN

const { syncMissingPresetModels, SyncPresetError } = await import('./sync-preset.js')
const { quickEnableLlmPreset } = await import('./quick-enable.js')
const { readConfigObject, updateConfigObject } = await import('../config-store.js')
const { saveSecret, describeSecretSource } = await import('./secrets.js')
const { AGIM_HOME } = await import('../agim-paths.js')
const { DEEPSEEK_VISION_MODEL } = await import('./presets.js')
const TMP = AGIM_HOME

describe('syncMissingPresetModels', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
  })

  it('adds DeepSeek vision onto an older pro/flash install and copies the key', async () => {
    await updateConfigObject((current) => ({
      config: {
        ...current,
        messengers: [],
        agents: ['agim'],
        defaultAgent: 'agim',
        llmBackends: [
          {
            name: 'deepseek-v4-pro',
            provider: 'openai-compat',
            model: 'deepseek-v4-pro',
            baseUrl: 'https://api.deepseek.com',
            label: 'deepseek',
          },
          {
            name: 'deepseek-v4-flash',
            provider: 'openai-compat',
            model: 'deepseek-v4-flash',
            baseUrl: 'https://api.deepseek.com',
            label: 'deepseek',
          },
        ],
      },
      result: undefined,
    }))
    saveSecret('deepseek-v4-pro', 'sk-existing')

    const result = await syncMissingPresetModels('deepseek')
    expect(result.added.map((b) => b.model)).toEqual([DEEPSEEK_VISION_MODEL])
    expect(result.added[0]?.name).toBe(DEEPSEEK_VISION_MODEL)

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ name: string; model: string; label?: string }>
    }
    expect(cfg.llmBackends?.map((b) => b.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      DEEPSEEK_VISION_MODEL,
    ])
    expect(cfg.llmBackends?.[2]?.label).toBe('deepseek')
    expect(describeSecretSource(DEEPSEEK_VISION_MODEL).source).not.toBe('none')
  })

  it('is a no-op when the full catalog is already present', async () => {
    await quickEnableLlmPreset({ apiKey: 'sk-full' })
    const again = await syncMissingPresetModels('deepseek')
    expect(again.added).toEqual([])
  })

  it('rejects an unknown or custom preset', async () => {
    await expect(syncMissingPresetModels('custom')).rejects.toBeInstanceOf(SyncPresetError)
    await expect(syncMissingPresetModels('nope')).rejects.toBeInstanceOf(SyncPresetError)
  })

  it('404s when the vendor group is not installed', async () => {
    try {
      await syncMissingPresetModels('deepseek')
      throw new Error('expected not_found')
    } catch (err) {
      expect(err).toBeInstanceOf(SyncPresetError)
      expect((err as SyncPresetError).code).toBe('not_found')
    }
  })
})
