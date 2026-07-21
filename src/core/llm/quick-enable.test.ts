import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-qe-'))
process.env.AGIM_HOME = TMP_OWN

const { quickEnableLlmPreset, QuickEnableError } = await import('./quick-enable.js')
const { readConfigObject } = await import('../config-store.js')
const { describeSecretSource } = await import('./secrets.js')
const { AGIM_HOME } = await import('../agim-paths.js')
const TMP = AGIM_HOME

describe('quickEnableLlmPreset', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
  })

  it('writes DeepSeek backend + roles + defaultAgent from an API key', async () => {
    const result = await quickEnableLlmPreset({ apiKey: 'sk-test-deepseek' })
    expect(result.preset).toBe('deepseek')
    expect(result.model).toBe('deepseek-v4-pro')
    expect(result.roles['native-chat']).toBe(result.name)
    expect(result.defaultAgent).toBe('agim')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ name: string; model: string; baseUrl: string }>
      llmRoles?: Record<string, string>
      defaultAgent?: string
      agents?: string[]
    }
    expect(cfg.llmBackends?.[0]?.model).toBe('deepseek-v4-pro')
    expect(cfg.llmBackends?.[0]?.baseUrl).toBe('https://api.deepseek.com')
    expect(cfg.llmRoles?.['native-chat']).toBe(result.name)
    expect(cfg.defaultAgent).toBe('agim')
    expect(cfg.agents).toContain('agim')
    expect(describeSecretSource(result.name).source).not.toBe('none')
    expect(existsSync(join(TMP, 'llm-secrets.json'))).toBe(true)
  })

  it('rejects empty api keys', async () => {
    await expect(quickEnableLlmPreset({ apiKey: '  ' })).rejects.toBeInstanceOf(QuickEnableError)
  })
})
