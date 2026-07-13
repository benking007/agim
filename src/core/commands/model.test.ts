// /model command — exercises the per-agent driver dispatch added in
// v1.2.50. We can't reach the real opencode / cursor-agent binaries
// in unit tests, so this set verifies behaviour against the agent
// switch + error messages only.

import { describe, it, expect, beforeEach } from 'bun:test'
import { handleModelCommand, _internal } from './model.js'
import { _resetRegistry, loadFromConfig } from '../llm/registry.js'

const baseCtx = {
  platform: 'test',
  channelId: 'c',
  threadId: 't',
  defaultAgent: 'agim',
  userId: 'u',
}

beforeEach(() => {
  _internal.invalidateModelCache()
  _resetRegistry()
  delete process.env.AGIM_LLM_SECRET_DEEPSEEK_AGIM
  delete process.env.AGIM_LLM_SECRET_QWEN_AGIM
})

describe('handleModelCommand — agent gating', () => {
  it('supports native by listing configured LLM backends', async () => {
    process.env.AGIM_LLM_SECRET_DEEPSEEK_AGIM = 'sk-test'
    loadFromConfig({
      llmBackends: [{
        name: 'deepseek-agim',
        provider: 'openai-compat',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
      }],
      llmRoles: { 'native-chat': 'deepseek-agim' },
    })

    const out = await handleModelCommand('list', { ...baseCtx, threadId: 'native-list' } as never)
    expect(out).toContain('native 模型列表')
    expect(out).toContain('deepseek-agim')
    expect(out).toContain('当前: `deepseek-agim`')
  })

  it('switches native sessions by backend name and can reset to role default', async () => {
    process.env.AGIM_LLM_SECRET_DEEPSEEK_AGIM = 'sk-test'
    process.env.AGIM_LLM_SECRET_QWEN_AGIM = 'sk-test'
    loadFromConfig({
      llmBackends: [
        {
          name: 'deepseek-agim',
          provider: 'openai-compat',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        {
          name: 'qwen-agim',
          provider: 'openai-compat',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-max',
        },
      ],
      llmRoles: { 'native-chat': 'deepseek-agim' },
    })

    const ctx = { ...baseCtx, threadId: 'native-switch' } as never
    const switched = await handleModelCommand('qwen-agim', ctx)
    expect(switched).toContain('模型已切换')
    expect(switched).toContain('qwen-agim')

    const current = await handleModelCommand('', ctx)
    expect(current).toContain('qwen-agim')

    const reset = await handleModelCommand('reset', ctx)
    expect(reset).toContain('deepseek-agim')
  })

  it('refresh works regardless of active agent', async () => {
    const out = await handleModelCommand('refresh', { ...baseCtx } as never)
    expect(out).toContain('缓存已清空')
  })
})
