// Unit tests for tryIntrospect — verifies it returns null on no-backend
// configured and on provider failure, and returns the text on success.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tryIntrospect } from './introspection.js'
import { loadFromConfig, _resetRegistry } from './registry.js'
import { saveSecret, envKeyForBackend, LLM_SECRETS_PATH } from './secrets.js'
import { existsSync, unlinkSync } from 'node:fs'

const ORIGINAL_FETCH = globalThis.fetch

function clearAll(): void {
  delete process.env[envKeyForBackend('test-cheap')]
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  _resetRegistry()
  globalThis.fetch = ORIGINAL_FETCH
}

beforeEach(clearAll)
afterEach(clearAll)

describe('tryIntrospect', () => {
  it('returns null when no backend is configured for the role', async () => {
    loadFromConfig({})
    const result = await tryIntrospect({ role: 'cheap', prompt: 'hi' })
    expect(result).toBeNull()
  })

  it('returns text when provider succeeds', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'distilled' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

    saveSecret('test-cheap', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'test-cheap', provider: 'openai-compat', model: 'm' }],
      llmRoles: { cheap: 'test-cheap' },
    })
    const result = await tryIntrospect({ role: 'cheap', prompt: 'extract' })
    expect(result).not.toBeNull()
    expect(result?.text).toBe('distilled')
    expect(result?.backendName).toBe('test-cheap')
    expect(result?.usage.totalTokens).toBe(5)
  })

  it('returns null when provider throws (transport error)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('econnreset')
    }) as unknown as typeof fetch

    saveSecret('test-cheap', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'test-cheap', provider: 'openai-compat', model: 'm', retryOnTransient: 0 }],
      llmRoles: { cheap: 'test-cheap' },
    })
    const result = await tryIntrospect({ role: 'cheap', prompt: 'extract' })
    expect(result).toBeNull()
  })

  it('returns null when provider returns HTTP 401', async () => {
    globalThis.fetch = (async () => new Response('bad token', { status: 401 })) as unknown as typeof fetch
    saveSecret('test-cheap', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'test-cheap', provider: 'openai-compat', model: 'm' }],
      llmRoles: { cheap: 'test-cheap' },
    })
    const result = await tryIntrospect({ role: 'cheap', prompt: 'extract' })
    expect(result).toBeNull()
  })

  it('respects custom timeoutMs', async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }, { once: true })
      })
    }) as unknown as typeof fetch
    saveSecret('test-cheap', 'sk-test')
    loadFromConfig({
      llmBackends: [{ name: 'test-cheap', provider: 'openai-compat', model: 'm', retryOnTransient: 0 }],
      llmRoles: { cheap: 'test-cheap' },
    })
    const start = Date.now()
    const result = await tryIntrospect({ role: 'cheap', prompt: 'extract', timeoutMs: 50 })
    const elapsed = Date.now() - start
    expect(result).toBeNull()
    // Allow generous slack so flaky CI doesn't fail; we just want to
    // confirm the timeout actually triggered (not 30s default).
    expect(elapsed).toBeLessThan(2000)
  })
})
