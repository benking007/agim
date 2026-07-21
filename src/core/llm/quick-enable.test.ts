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

  it('writes DeepSeek backends (pro + flash) + roles + defaultAgent from an API key', async () => {
    const result = await quickEnableLlmPreset({ apiKey: 'sk-test-deepseek' })
    expect(result.preset).toBe('deepseek')
    expect(result.name).toBe('deepseek-v4-pro')
    expect(result.model).toBe('deepseek-v4-pro')
    expect(result.backends?.map((b) => b.model)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    expect(result.backends?.map((b) => b.name)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    expect(result.roles['native-chat']).toBe(result.name)
    expect(result.defaultAgent).toBe('agim')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ name: string; model: string; baseUrl: string; label?: string }>
      llmRoles?: Record<string, string>
      defaultAgent?: string
      agents?: string[]
    }
    expect(cfg.llmBackends?.map((b) => b.model)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    expect(cfg.llmBackends?.[0]?.baseUrl).toBe('https://api.deepseek.com')
    expect(cfg.llmBackends?.every((b) => b.label === 'deepseek')).toBe(true)
    expect(cfg.llmRoles?.['native-chat']).toBe(result.name)
    expect(cfg.llmRoles?.cheap).toBe(result.backends?.[1]?.name)
    expect(cfg.defaultAgent).toBe('agim')
    expect(cfg.agents).toContain('agim')
    expect(describeSecretSource(result.name).source).not.toBe('none')
    expect(describeSecretSource(result.backends?.[1]?.name ?? '').source).not.toBe('none')
    expect(existsSync(join(TMP, 'llm-secrets.json'))).toBe(true)
  })

  it('writes Kimi backends (k3 + k2.6) + roles from an API key', async () => {
    const result = await quickEnableLlmPreset({
      preset: 'moonshot',
      apiKey: 'sk-test-kimi',
    })
    expect(result.preset).toBe('moonshot')
    expect(result.name).toBe('kimi-k3')
    expect(result.model).toBe('kimi-k3')
    expect(result.backends?.map((b) => b.model)).toEqual(['kimi-k3', 'kimi-k2.6'])
    expect(result.backends?.map((b) => b.name)).toEqual(['kimi-k3', 'kimi-k2.6'])
    expect(result.roles['native-chat']).toBe('kimi-k3')
    expect(result.roles.cheap).toBe('kimi-k2.6')
    expect(result.roles.evaluator).toBe('kimi-k2.6')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ name: string; model: string; baseUrl: string; label?: string }>
      llmRoles?: Record<string, string>
    }
    expect(cfg.llmBackends?.map((b) => b.model)).toEqual(['kimi-k3', 'kimi-k2.6'])
    expect(cfg.llmBackends?.[0]?.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(cfg.llmBackends?.every((b) => b.label === 'moonshot')).toBe(true)
    expect(cfg.llmRoles?.['native-chat']).toBe('kimi-k3')
    expect(describeSecretSource('kimi-k3').source).not.toBe('none')
    expect(describeSecretSource('kimi-k2.6').source).not.toBe('none')
  })

  it('writes GLM backends (5.2 + 4.7-flash) + roles from an API key', async () => {
    const result = await quickEnableLlmPreset({
      preset: 'zhipu',
      apiKey: 'sk-test-glm',
    })
    expect(result.preset).toBe('zhipu')
    expect(result.name).toBe('glm-5.2')
    expect(result.model).toBe('glm-5.2')
    expect(result.backends?.map((b) => b.model)).toEqual(['glm-5.2', 'glm-4.7-flash'])
    expect(result.backends?.map((b) => b.name)).toEqual(['glm-5.2', 'glm-4.7-flash'])
    expect(result.roles['native-chat']).toBe('glm-5.2')
    expect(result.roles.cheap).toBe('glm-4.7-flash')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ name: string; model: string; baseUrl: string; label?: string }>
    }
    expect(cfg.llmBackends?.[0]?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(cfg.llmBackends?.every((b) => b.label === 'zhipu')).toBe(true)
    expect(describeSecretSource('glm-5.2').source).not.toBe('none')
  })

  it('writes MiMo backends (v2.5-pro + v2.5) + roles from an API key', async () => {
    const result = await quickEnableLlmPreset({
      preset: 'mimo',
      apiKey: 'sk-test-mimo',
    })
    expect(result.preset).toBe('mimo')
    expect(result.name).toBe('mimo-v2.5-pro')
    expect(result.model).toBe('mimo-v2.5-pro')
    expect(result.backends?.map((b) => b.model)).toEqual(['mimo-v2.5-pro', 'mimo-v2.5'])
    expect(result.backends?.map((b) => b.name)).toEqual(['mimo-v2.5-pro', 'mimo-v2.5'])
    expect(result.roles['native-chat']).toBe('mimo-v2.5-pro')
    expect(result.roles.cheap).toBe('mimo-v2.5')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ name: string; model: string; baseUrl: string; label?: string }>
    }
    expect(cfg.llmBackends?.[0]?.baseUrl).toBe('https://api.xiaomimimo.com/v1')
    expect(cfg.llmBackends?.every((b) => b.label === 'mimo')).toBe(true)
    expect(describeSecretSource('mimo-v2.5-pro').source).not.toBe('none')
    expect(describeSecretSource('mimo-v2.5').source).not.toBe('none')
  })

  it('rejects a second quick-enable for the same built-in preset', async () => {
    await quickEnableLlmPreset({ preset: 'deepseek', apiKey: 'sk-1' })
    await expect(
      quickEnableLlmPreset({ preset: 'deepseek', apiKey: 'sk-2' }),
    ).rejects.toMatchObject({
      name: 'QuickEnableError',
      code: 'conflict',
      message: expect.stringMatching(/already configured/i),
    })
  })

  it('rejects quick-enable when the same hostname exists without label', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(TMP, 'config.json'), JSON.stringify({
      messengers: [],
      agents: ['agim'],
      llmBackends: [
        {
          name: 'hand-ds',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
        },
      ],
    }), 'utf8')
    await expect(
      quickEnableLlmPreset({ preset: 'deepseek', apiKey: 'sk-host' }),
    ).rejects.toMatchObject({
      name: 'QuickEnableError',
      code: 'conflict',
      message: expect.stringMatching(/already configured/i),
    })
  })

  it('rejects quick-enable when an intl vendor host family is already present', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(TMP, 'config.json'), JSON.stringify({
      messengers: [],
      agents: ['agim'],
      llmBackends: [
        {
          name: 'kimi-intl',
          provider: 'openai-compat',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k3',
        },
      ],
    }), 'utf8')
    await expect(
      quickEnableLlmPreset({ preset: 'moonshot', apiKey: 'sk-kimi' }),
    ).rejects.toMatchObject({
      name: 'QuickEnableError',
      code: 'conflict',
      message: expect.stringMatching(/already configured/i),
    })
  })

  it('rejects empty api keys', async () => {
    await expect(quickEnableLlmPreset({ apiKey: '  ' })).rejects.toBeInstanceOf(QuickEnableError)
  })
})
