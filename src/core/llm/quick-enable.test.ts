import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_OWN = mkdtempSync(join(tmpdir(), 'agim-qe-'))
process.env.AGIM_HOME = TMP_OWN

const { quickEnableLlmPreset, QuickEnableError } = await import('./quick-enable.js')
const { readConfigObject } = await import('../config-store.js')
const { describeSecretSource, loadSecretsFile, secretHintForBackend } = await import('./secrets.js')
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
    expect(result.backends?.map((b) => b.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ])
    expect(result.backends?.map((b) => b.name)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ])
    expect(result.roles['native-chat']).toBe(result.name)
    expect(result.defaultAgent).toBe('agim')
    expect(result.dialect).toBe('openai')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ name: string; model: string; baseUrl: string; label?: string }>
      llmRoles?: Record<string, string>
      defaultAgent?: string
      agents?: string[]
    }
    expect(cfg.llmBackends?.map((b) => b.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ])
    expect(cfg.llmBackends?.[0]?.baseUrl).toBe('https://api.deepseek.com')
    expect(cfg.llmBackends?.every((b) => b.label === 'deepseek')).toBe(true)
    expect(cfg.llmRoles?.['native-chat']).toBe(result.name)
    expect(cfg.llmRoles?.cheap).toBe(result.backends?.[1]?.name)
    expect(cfg.defaultAgent).toBe('agim')
    expect(cfg.agents).toContain('agim')
    const dsHint = secretHintForBackend(
      { name: result.name, baseUrl: 'https://api.deepseek.com', label: 'deepseek' },
      (cfg.llmBackends ?? []).map((b) => ({ name: b.name, baseUrl: b.baseUrl, label: b.label })),
    )
    expect(describeSecretSource(result.name, dsHint).source).toBe('file')
    expect(describeSecretSource(result.backends?.[1]?.name ?? '', dsHint).source).toBe('file')
    expect(loadSecretsFile().keys.deepseek).toBe('sk-test-deepseek')
    expect(loadSecretsFile().keys['deepseek-v4-pro']).toBeUndefined()
    expect(loadSecretsFile().keys['deepseek-v4-flash']).toBeUndefined()
    expect(existsSync(join(TMP, 'llm-secrets.json'))).toBe(true)
  })

  it('writes DeepSeek Anthropic dialect backends with anthropic provider + base', async () => {
    const result = await quickEnableLlmPreset({
      apiKey: 'sk-test-deepseek-ant',
      dialect: 'anthropic',
    })
    expect(result.provider).toBe('anthropic')
    expect(result.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(result.dialect).toBe('anthropic')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ provider: string; baseUrl: string; label?: string }>
    }
    expect(cfg.llmBackends?.[0]?.provider).toBe('anthropic')
    expect(cfg.llmBackends?.[0]?.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(cfg.llmBackends?.every((b) => b.label === 'deepseek')).toBe(true)
  })

  it('writes DeepSeek strictTools flag when requested', async () => {
    const result = await quickEnableLlmPreset({
      apiKey: 'sk-test-deepseek-strict',
      strictTools: true,
    })
    expect(result.strictTools).toBe(true)
    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ strictTools?: boolean }>
    }
    expect(cfg.llmBackends?.[0]?.strictTools).toBe(true)
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
    const kimiHint = { label: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1' }
    expect(describeSecretSource('kimi-k3', kimiHint).source).toBe('file')
    expect(describeSecretSource('kimi-k2.6', kimiHint).source).toBe('file')
    expect(loadSecretsFile().keys.moonshot).toBe('sk-test-kimi')
    expect(loadSecretsFile().keys['kimi-k3']).toBeUndefined()
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
    expect(describeSecretSource('glm-5.2', { label: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }).source).toBe('file')
    expect(loadSecretsFile().keys.zhipu).toBe('sk-test-glm')
    expect(loadSecretsFile().keys['glm-5.2']).toBeUndefined()
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
    const mimoHint = { label: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1' }
    expect(describeSecretSource('mimo-v2.5-pro', mimoHint).source).toBe('file')
    expect(describeSecretSource('mimo-v2.5', mimoHint).source).toBe('file')
    expect(loadSecretsFile().keys.mimo).toBe('sk-test-mimo')
    expect(loadSecretsFile().keys['mimo-v2.5-pro']).toBeUndefined()
  })

  it('rebinds an already-installed preset: updates the vendor key and fills missing models', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(TMP, 'config.json'), JSON.stringify({
      messengers: [],
      agents: ['agim'],
      llmBackends: [
        {
          name: 'deepseek-v4-pro',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
          label: 'deepseek',
        },
        {
          name: 'deepseek-v4-flash',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-v4-flash',
          label: 'deepseek',
        },
      ],
    }), 'utf8')
    const { saveSecret } = await import('./secrets.js')
    saveSecret('deepseek-v4-pro', 'sk-old')

    const result = await quickEnableLlmPreset({ preset: 'deepseek', apiKey: 'sk-2' })
    expect(result.rebound).toBe(true)
    expect(result.added?.map((b) => b.model)).toEqual(['deepseek-v4-flash-vision-exp'])
    expect(result.backends.map((b) => b.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ])
    expect(loadSecretsFile().keys.deepseek).toBe('sk-2')

    const cfg = await readConfigObject() as {
      llmBackends?: Array<{ model: string }>
    }
    expect(cfg.llmBackends?.map((b) => b.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ])
  })

  it('rebinds when the same hostname exists without label', async () => {
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
    const result = await quickEnableLlmPreset({ preset: 'deepseek', apiKey: 'sk-host' })
    expect(result.rebound).toBe(true)
    expect(result.backends.some((b) => b.model === 'deepseek-v4-flash-vision-exp')).toBe(true)
    expect(loadSecretsFile().keys.deepseek).toBe('sk-host')
  })

  it('rebinds when an intl vendor host family is already present', async () => {
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
    const result = await quickEnableLlmPreset({ preset: 'moonshot', apiKey: 'sk-kimi' })
    expect(result.rebound).toBe(true)
    expect(result.backends.map((b) => b.model)).toContain('kimi-k2.6')
    expect(loadSecretsFile().keys.moonshot).toBe('sk-kimi')
  })

  it('second quick-enable on a full catalog is a no-op rebind (key only)', async () => {
    await quickEnableLlmPreset({ preset: 'deepseek', apiKey: 'sk-1' })
    const again = await quickEnableLlmPreset({ preset: 'deepseek', apiKey: 'sk-2' })
    expect(again.rebound).toBe(true)
    expect(again.added).toEqual([])
    expect(again.backends).toHaveLength(3)
    expect(loadSecretsFile().keys.deepseek).toBe('sk-2')
  })

  it('rejects empty api keys', async () => {
    await expect(quickEnableLlmPreset({ apiKey: '  ' })).rejects.toBeInstanceOf(QuickEnableError)
  })

  it('still SSRF-checks a user-supplied baseUrl override', async () => {
    await expect(quickEnableLlmPreset({
      preset: 'moonshot',
      apiKey: 'sk-test-kimi',
      baseUrl: 'http://127.0.0.1:9/v1',
    })).rejects.toMatchObject({ name: 'QuickEnableError', code: 'validation' })
  })
})
