// Unit tests for the native AgentAdapter.
//
// Strategy: stub the LLM registry by configuring a fake OpenAI-compat
// backend whose fetch is mocked, then call the adapter's sendPrompt and
// assert on the AsyncGenerator output + describeNativeAgent banner.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { nativeAgentAdapter, describeNativeAgent } from './index.js'
import {
  loadFromConfig,
  _resetRegistry,
} from '../../../core/llm/index.js'
import {
  saveSecret,
  envKeyForBackend,
  LLM_SECRETS_PATH,
} from '../../../core/llm/secrets.js'
import { existsSync, unlinkSync } from 'node:fs'

const ORIGINAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  'IMHUB_NATIVE_AGENT_ROLE',
  'IMHUB_NATIVE_AGENT_MODE',
  'IMHUB_NATIVE_AGENT_AUTOALLOW',
  'IMHUB_NATIVE_AGENT_DENYLIST',
  envKeyForBackend('native-mock'),
]

function clearAll(): void {
  for (const k of ENV_KEYS) delete process.env[k]
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  _resetRegistry()
  globalThis.fetch = ORIGINAL_FETCH
}

function configureBackend(role: string = 'native-chat'): void {
  saveSecret('native-mock', 'sk-test')
  loadFromConfig({
    llmBackends: [{
      name: 'native-mock', provider: 'openai-compat', model: 'gpt-4.1-mini',
    }],
    llmRoles: { [role]: 'native-mock' },
  })
}

function makeChatResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function collect(g: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const c of g) out.push(c)
  return out
}

beforeEach(clearAll)
afterEach(clearAll)

describe('nativeAgentAdapter — identity', () => {
  it('exposes name=native + sensible aliases', () => {
    expect(nativeAgentAdapter.name).toBe('native')
    expect(nativeAgentAdapter.aliases).toContain('llm')
    expect(nativeAgentAdapter.aliases).toContain('na')
  })
})

describe('nativeAgentAdapter — isAvailable', () => {
  it('returns false when no LLM backend is registered', async () => {
    loadFromConfig({})
    expect(await nativeAgentAdapter.isAvailable()).toBe(false)
  })

  it('returns true when native-chat role is configured', async () => {
    configureBackend('native-chat')
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })

  it('returns true when only cheap role is configured (fallback)', async () => {
    configureBackend('cheap')
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })

  it('honours IMHUB_NATIVE_AGENT_ROLE env override', async () => {
    // Configure a 'custom-role' backend; without env, fallback chain
    // skips it. With env, it becomes the preferred role.
    saveSecret('native-mock', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'native-mock', provider: 'openai-compat', model: 'gpt' }],
      llmRoles: { 'custom-role': 'native-mock' },
    })
    expect(await nativeAgentAdapter.isAvailable()).toBe(false)
    process.env.IMHUB_NATIVE_AGENT_ROLE = 'custom-role'
    expect(await nativeAgentAdapter.isAvailable()).toBe(true)
  })
})

describe('nativeAgentAdapter — sendPrompt', () => {
  it('with no backend: yields a helpful error and stops', async () => {
    loadFromConfig({})
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'hi'))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('no LLM backend')
  })

  it('with a backend: yields the LLM text as a single chunk', async () => {
    configureBackend()
    globalThis.fetch = (async () => makeChatResponse('hello from native')) as unknown as typeof fetch
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'say hi'))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('hello from native')
  })

  it('threads history into the LLM messages array', async () => {
    configureBackend()
    let seenMessages: Array<{ role: string; content: string }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ role: string; content: string }>
      }
      seenMessages = body.messages
      return makeChatResponse('reply')
    }) as unknown as typeof fetch

    await collect(nativeAgentAdapter.sendPrompt(
      'sess',
      'next question',
      [
        { role: 'user', content: 'first', timestamp: new Date() },
        { role: 'assistant', content: 'first answer', timestamp: new Date() },
      ],
    ))

    // First message is the synthetic system prompt (injected by the
    // provider's system= option). Then history. Then the new user msg.
    expect(seenMessages[0].role).toBe('system')
    expect(seenMessages[1].role).toBe('user')
    expect(seenMessages[1].content).toBe('first')
    expect(seenMessages[2].role).toBe('assistant')
    expect(seenMessages[2].content).toBe('first answer')
    expect(seenMessages[3].role).toBe('user')
    expect(seenMessages[3].content).toBe('next question')
  })

  it('skips empty history entries', async () => {
    configureBackend()
    let seenMessages: Array<{ role: string; content: string }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ role: string; content: string }>
      }
      seenMessages = body.messages
      return makeChatResponse('ok')
    }) as unknown as typeof fetch

    await collect(nativeAgentAdapter.sendPrompt(
      'sess',
      'q',
      [
        { role: 'user', content: '', timestamp: new Date() },
        { role: 'assistant', content: 'a', timestamp: new Date() },
      ],
    ))
    // Roles after system + user-prompt
    const nonSystem = seenMessages.filter((m) => m.role !== 'system')
    expect(nonSystem).toEqual([
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q' },
    ])
  })

  it('handles provider HTTP error gracefully', async () => {
    configureBackend()
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'x'))
    expect(chunks[0]).toMatch(/native agent error/i)
  })

  it('reports empty response as a friendly placeholder', async () => {
    configureBackend()
    globalThis.fetch = (async () => makeChatResponse('')) as unknown as typeof fetch
    const chunks = await collect(nativeAgentAdapter.sendPrompt('sess', 'x'))
    expect(chunks[0]).toMatch(/empty response/i)
  })

  it('propagates costUsd to opts.onUsage', async () => {
    configureBackend()
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0042 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    let seenCost: number | undefined
    await collect(nativeAgentAdapter.sendPrompt('sess', 'x', [], {
      onUsage: (delta) => { seenCost = delta.costUsd },
    }))
    expect(seenCost).toBeCloseTo(0.0042, 6)
  })
})

describe('describeNativeAgent — banner', () => {
  it('reports NOT CONFIGURED when no backend', () => {
    loadFromConfig({})
    expect(describeNativeAgent()).toContain('NOT CONFIGURED')
  })

  it('reports backend name + policy when configured', () => {
    configureBackend()
    const banner = describeNativeAgent()
    expect(banner).toContain('backend=native-mock')
    expect(banner).toContain('role=native-chat')
    expect(banner).toContain('mode=allow-list')
  })
})
