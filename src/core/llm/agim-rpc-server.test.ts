// agim-rpc-server tests — token auth, whitelist, transport round-trip.
//
// We DON'T spin up a real Unix socket here (CI flakiness around socket
// permissions). Instead, the tests target the pure pieces:
//   - mintRpcToken + token registry semantics
//   - resolveSocketPath env override
//   - the whitelist of tool names exported via DEFAULT
//   - static token + llm_complete dispatch (mock provider)
// The handler-with-real-socket integration is covered by manual smoke
// once the bin/agim_rpc.py script is exercised in a live agim install.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  mintRpcToken,
  revokeRpcToken,
  resolveSocketPath,
  registerStaticRpcTokenFromEnv,
  _peekTokensForTests,
  _dispatchForTests,
  _resolveAllowedToolsForTests,
} from './agim-rpc-server.js'
import { loadFromConfig, _resetRegistry } from './registry.js'
import { _resetLlmRpcRegistryLatchForTests } from './llm-rpc.js'

describe('agim-rpc-server — token registry', () => {
  beforeEach(() => {
    // Cheap reset: walk the live map and drop everything. Module-level
    // singletons survive across tests within one bun process.
    const tokens = _peekTokensForTests()
    for (const t of Array.from(tokens.keys())) tokens.delete(t)
  })

  it('mintRpcToken returns a 64-char hex token bound to the given ctx', () => {
    const r = mintRpcToken({ platform: 'telegram', channelId: '', threadId: 't1', userId: 'u1' })
    expect(r.token).toMatch(/^[a-f0-9]{64}$/)
    expect(r.socketPath).toBe(resolveSocketPath())
    expect(r.expiresAt).toBeGreaterThan(Date.now())
    const tokens = _peekTokensForTests()
    expect(tokens.has(r.token)).toBe(true)
    expect(tokens.get(r.token)?.ctx.threadId).toBe('t1')
  })

  it('two mints return different tokens', () => {
    const a = mintRpcToken({ platform: 'wechat', channelId: 'c', threadId: 't1', userId: 'u' })
    const b = mintRpcToken({ platform: 'wechat', channelId: 'c', threadId: 't1', userId: 'u' })
    expect(a.token).not.toBe(b.token)
    expect(_peekTokensForTests().size).toBe(2)
  })

  it('revokeRpcToken removes the entry', () => {
    const r = mintRpcToken({ platform: 'x', channelId: '', threadId: 't', userId: 'u' })
    expect(_peekTokensForTests().has(r.token)).toBe(true)
    revokeRpcToken(r.token)
    expect(_peekTokensForTests().has(r.token)).toBe(false)
  })

  it('revoke is a no-op on unknown token', () => {
    revokeRpcToken('not-a-real-token')
    // No throw, no state change.
    expect(_peekTokensForTests().size).toBe(0)
  })
})

describe('agim-rpc-server — socket path resolution', () => {
  const savedEnv = process.env.AGIM_RPC_SOCKET

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGIM_RPC_SOCKET
    else process.env.AGIM_RPC_SOCKET = savedEnv
  })

  it('uses AGIM_RPC_SOCKET when set', () => {
    process.env.AGIM_RPC_SOCKET = '/tmp/custom-agim.sock'
    expect(resolveSocketPath()).toBe('/tmp/custom-agim.sock')
  })

  it('falls back to AGIM_HOME/rpc.sock when env is unset', () => {
    delete process.env.AGIM_RPC_SOCKET
    expect(resolveSocketPath()).toMatch(/rpc\.sock$/)
  })
})

describe('agim-rpc-server — static token + llm_complete', () => {
  const savedStatic = process.env.AGIM_RPC_STATIC_TOKEN
  const savedStaticTtl = process.env.AGIM_RPC_STATIC_TOKEN_TTL_MS
  const savedAllowed = process.env.AGIM_RPC_ALLOWED_TOOLS
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    const tokens = _peekTokensForTests()
    for (const t of Array.from(tokens.keys())) tokens.delete(t)
    delete process.env.AGIM_RPC_STATIC_TOKEN
    delete process.env.AGIM_RPC_STATIC_TOKEN_TTL_MS
    delete process.env.AGIM_RPC_ALLOWED_TOOLS
    _resetRegistry()
    _resetLlmRpcRegistryLatchForTests()
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    if (savedStatic === undefined) delete process.env.AGIM_RPC_STATIC_TOKEN
    else process.env.AGIM_RPC_STATIC_TOKEN = savedStatic
    if (savedStaticTtl === undefined) delete process.env.AGIM_RPC_STATIC_TOKEN_TTL_MS
    else process.env.AGIM_RPC_STATIC_TOKEN_TTL_MS = savedStaticTtl
    if (savedAllowed === undefined) delete process.env.AGIM_RPC_ALLOWED_TOOLS
    else process.env.AGIM_RPC_ALLOWED_TOOLS = savedAllowed
    _resetRegistry()
    _resetLlmRpcRegistryLatchForTests()
    globalThis.fetch = originalFetch
  })

  it('llm_* tools are opt-in via AGIM_RPC_ALLOWED_TOOLS (not in default whitelist)', () => {
    expect(_resolveAllowedToolsForTests().has('mcp__agim__llm_complete')).toBe(false)
    expect(_resolveAllowedToolsForTests().has('mcp__agim__llm_fim')).toBe(false)
    expect(_resolveAllowedToolsForTests().has('mcp__agim__llm_responses')).toBe(false)
    process.env.AGIM_RPC_ALLOWED_TOOLS = 'mcp__agim__llm_complete,mcp__agim__llm_fim,mcp__agim__llm_responses'
    expect(_resolveAllowedToolsForTests().has('mcp__agim__llm_complete')).toBe(true)
    expect(_resolveAllowedToolsForTests().has('mcp__agim__llm_fim')).toBe(true)
    expect(_resolveAllowedToolsForTests().has('mcp__agim__llm_responses')).toBe(true)
  })

  it('registers AGIM_RPC_STATIC_TOKEN with empty threadId and origin=static', () => {
    const token = 'a'.repeat(64)
    process.env.AGIM_RPC_STATIC_TOKEN = token
    expect(registerStaticRpcTokenFromEnv()).toBe(true)
    const entry = _peekTokensForTests().get(token)
    expect(entry?.origin).toBe('static')
    expect(entry?.ctx.platform).toBe('service')
    expect(entry?.ctx.threadId).toBe('')
    expect(entry?.expiresAt).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('static token dispatch: llm_complete/fim/responses work; push_message is refused', async () => {
    const { saveSecret, LLM_SECRETS_PATH } = await import('./secrets.js')
    const { existsSync, unlinkSync } = await import('node:fs')
    if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
    saveSecret('deepseek-v4-pro', 'sk-test')
    loadFromConfig({
      llmBackends: [{
        name: 'deepseek-v4-pro',
        provider: 'openai-compat',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
      }],
    })
    globalThis.fetch = (async (input: string) => {
      const url = String(input)
      if (url.includes('/beta/completions')) {
        return new Response(JSON.stringify({
          choices: [{ text: 'fim-ok', finish_reason: 'stop' }],
          model: 'deepseek-v4-pro',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/responses')) {
        return new Response(JSON.stringify({
          status: 'completed',
          model: 'deepseek-v4-pro',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'resp-ok' }] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'rpc-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const token = 'b'.repeat(64)
    process.env.AGIM_RPC_STATIC_TOKEN = token
    registerStaticRpcTokenFromEnv()
    const entry = _peekTokensForTests().get(token)!

    const llm = await _dispatchForTests(
      'mcp__agim__llm_complete',
      {
        backend: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'ping' }],
      },
      entry.ctx,
    )
    expect(llm.ok).toBe(true)
    if (llm.ok) {
      expect((llm.result as { text?: string }).text).toBe('rpc-ok')
    }

    const fim = await _dispatchForTests(
      'mcp__agim__llm_fim',
      { backend: 'deepseek-v4-pro', prompt: 'def f():' },
      entry.ctx,
    )
    expect(fim.ok).toBe(true)
    if (fim.ok) {
      expect((fim.result as { text?: string }).text).toBe('fim-ok')
    }

    const responses = await _dispatchForTests(
      'mcp__agim__llm_responses',
      { backend: 'deepseek-v4-pro', input: 'hi' },
      entry.ctx,
    )
    expect(responses.ok).toBe(true)
    if (responses.ok) {
      expect((responses.result as { outputText?: string }).outputText).toBe('resp-ok')
    }

    const push = await _dispatchForTests(
      'mcp__agim__push_message',
      { text: 'hello' },
      entry.ctx,
    )
    expect(push.ok).toBe(false)
    if (!push.ok) expect(push.error).toMatch(/thread-bound|static/)

    if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  })
})
