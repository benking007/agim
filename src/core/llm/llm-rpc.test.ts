import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync } from 'node:fs'
import { loadFromConfig, _resetRegistry } from './registry.js'
import { saveSecret, LLM_SECRETS_PATH } from './secrets.js'
import {
  handleLlmFimOp,
  handleLlmOp,
  handleLlmResponsesOp,
  _resetLlmRpcRegistryLatchForTests,
} from './llm-rpc.js'

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

function loadDeepSeekBackend(opts?: { baseUrl?: string; model?: string }): void {
  saveSecret('deepseek-v4-pro', 'sk-test')
  loadFromConfig({
    llmBackends: [{
      name: 'deepseek-v4-pro',
      provider: 'openai-compat',
      model: opts?.model ?? 'deepseek-v4-pro',
      baseUrl: opts?.baseUrl ?? 'https://api.deepseek.com',
    }],
  })
}

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
    loadDeepSeekBackend({ baseUrl: 'https://example.invalid/v1' })

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

  it('forwards assistant prefix:true for Chat Prefix Completion', async () => {
    loadDeepSeekBackend()
    let seenBody: Record<string, unknown> = {}
    let seenUrl = ''
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      seenUrl = String(input)
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'print(1)' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const r = await handleLlmOp({
      backend: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'complete' },
        { role: 'assistant', content: 'print(', prefix: true },
      ],
    })
    expect(r.ok).toBe(true)
    expect(seenUrl).toContain('/beta/')
    const msgs = seenBody.messages as Array<{ prefix?: boolean }>
    expect(msgs?.at(-1)?.prefix).toBe(true)
  })
})

describe('handleLlmFimOp', () => {
  it('rejects non-DeepSeek backends', async () => {
    saveSecret('openai', 'sk-test')
    loadFromConfig({
      llmBackends: [{
        name: 'openai',
        provider: 'openai-compat',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      }],
    })
    const r = await handleLlmFimOp({ backend: 'openai', prompt: 'def f():' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/DeepSeek openai-compat/)
  })

  it('returns FIM text from DeepSeek beta completions', async () => {
    loadDeepSeekBackend()
    let seenUrl = ''
    globalThis.fetch = (async (input: string) => {
      seenUrl = String(input)
      return new Response(JSON.stringify({
        choices: [{ text: '    return a+b', finish_reason: 'stop' }],
        model: 'deepseek-v4-pro',
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const r = await handleLlmFimOp({
      backend: 'deepseek-v4-pro',
      prompt: 'def add(a,b):\n',
      suffix: '\nprint(add(1,2))',
    })
    expect(r.ok).toBe(true)
    expect(seenUrl).toContain('/beta/completions')
    if (r.ok) {
      expect(r.result.text).toContain('return a+b')
      expect(r.result.modelUsed).toBe('deepseek-v4-pro')
    }
  })
})

describe('handleLlmResponsesOp', () => {
  it('rejects Anthropic DeepSeek dialect', async () => {
    saveSecret('deepseek-v4-pro', 'sk-test')
    loadFromConfig({
      llmBackends: [{
        name: 'deepseek-v4-pro',
        provider: 'anthropic',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/anthropic',
      }],
    })
    const r = await handleLlmResponsesOp({
      backend: 'deepseek-v4-pro',
      input: 'hi',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/openai-compat|Anthropic/)
  })

  it('returns output_text from Responses API', async () => {
    loadDeepSeekBackend({ model: 'deepseek-v4-flash' })
    let seenUrl = ''
    globalThis.fetch = (async (input: string) => {
      seenUrl = String(input)
      return new Response(JSON.stringify({
        id: 'resp_1',
        status: 'completed',
        model: 'deepseek-v4-flash',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const r = await handleLlmResponsesOp({
      backend: 'deepseek-v4-pro',
      input: 'ping',
      instructions: 'Be brief',
    })
    expect(r.ok).toBe(true)
    expect(seenUrl).toContain('/responses')
    if (r.ok) {
      expect(r.result.outputText).toBe('pong')
      expect(r.result.modelUsed).toBe('deepseek-v4-flash')
    }
  })
})
