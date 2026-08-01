import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync } from 'node:fs'
import { loadFromConfig, _resetRegistry } from './registry.js'
import { saveSecret, LLM_SECRETS_PATH } from './secrets.js'
import { handleLlmOp, _resetLlmRpcRegistryLatchForTests } from './llm-rpc.js'

const originalFetch = globalThis.fetch

beforeEach(() => {
  _resetRegistry()
  _resetLlmRpcRegistryLatchForTests()
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  globalThis.fetch = originalFetch
})

afterEach(() => {
  _resetRegistry()
  _resetLlmRpcRegistryLatchForTests()
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  globalThis.fetch = originalFetch
})

describe('handleLlmOp', () => {
  it('rejects missing backend', async () => {
    const r = await handleLlmOp({
      backend: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/backend and messages/)
  })

  it('rejects missing messages', async () => {
    const r = await handleLlmOp({
      backend: 'deepseek-v4-pro',
      messages: [],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/backend and messages/)
  })

  it('rejects unknown backend', async () => {
    const r = await handleLlmOp({
      backend: 'no-such-backend',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('backend not configured: no-such-backend')
  })

  it('returns text from a configured mock provider', async () => {
    saveSecret('deepseek-v4-pro', 'sk-test')
    loadFromConfig({
      llmBackends: [{
        name: 'deepseek-v4-pro',
        provider: 'openai-compat',
        model: 'deepseek-chat',
        baseUrl: 'https://example.invalid/v1',
      }],
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '你好，我是模型。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    const r = await handleLlmOp({
      backend: 'deepseek-v4-pro',
      system: 'be brief',
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
      temperature: 0.3,
      maxTokens: 64,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.text).toContain('你好')
      expect(r.result.text.length).toBeGreaterThan(0)
    }
  })
})
