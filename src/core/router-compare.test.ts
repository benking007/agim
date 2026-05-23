// Unit tests for router-compare (Stage 5).
// Mostly exercises the pure helpers (parseBackendRef, formatCompareResult)
// + a smoke run against runRouterCompare using stub registry-style
// LLM providers via globalThis.fetch mocking.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  parseBackendRef,
  formatCompareResult,
  runRouterCompare,
  type CompareResult, type SideResult,
} from './router-compare.js'

describe('parseBackendRef', () => {
  it('parses valid kind:name specs', () => {
    expect(parseBackendRef('agent:claude-code')).toEqual({ kind: 'agent', name: 'claude-code' })
    expect(parseBackendRef('llm:cheap')).toEqual({ kind: 'llm', name: 'cheap' })
    expect(parseBackendRef('backend:deepseek_chat-1')).toEqual({ kind: 'backend', name: 'deepseek_chat-1' })
  })

  it('rejects malformed specs', () => {
    expect(parseBackendRef('claude-code')).toBeNull()
    expect(parseBackendRef('agent:')).toBeNull()
    expect(parseBackendRef(':claude-code')).toBeNull()
    expect(parseBackendRef('rogue:claude-code')).toBeNull()
    expect(parseBackendRef('agent:bad name')).toBeNull()
    expect(parseBackendRef('')).toBeNull()
  })
})

describe('formatCompareResult', () => {
  function side(label: 'A' | 'B', ok: boolean, text = '', error?: string): SideResult {
    return {
      ref: { kind: 'llm', name: label.toLowerCase() },
      ok, text,
      durationMs: 123,
      tokensIn: ok ? 10 : undefined,
      tokensOut: ok ? 20 : undefined,
      error,
    }
  }

  it('renders header + two side blocks when both ok', () => {
    const r: CompareResult = {
      a: side('A', true, 'hello from A'),
      b: side('B', true, 'reply from B'),
      input: { prompt: 'hi', a: { kind: 'llm', name: 'a' }, b: { kind: 'llm', name: 'b' } },
    }
    const out = formatCompareResult(r)
    expect(out).toContain('🆚')
    expect(out).toContain('**A**')
    expect(out).toContain('**B**')
    expect(out).toContain('hello from A')
    expect(out).toContain('reply from B')
    expect(out).toContain('tokens 10→20')
  })

  it('renders error inline when a side failed', () => {
    const r: CompareResult = {
      a: side('A', false, '', 'no backend'),
      b: side('B', true, 'ok'),
      input: { prompt: 'hi', a: { kind: 'llm', name: 'a' }, b: { kind: 'llm', name: 'b' } },
    }
    const out = formatCompareResult(r)
    expect(out).toContain('❌')
    expect(out).toContain('no backend')
    expect(out).toContain('ok')
  })

  it('appends judge verdict when present', () => {
    const r: CompareResult = {
      a: side('A', true, 'a'),
      b: side('B', true, 'b'),
      judge: { pick: 'a', reason: 'A was more direct', backendName: 'deepseek', durationMs: 50 },
      input: { prompt: 'hi', a: { kind: 'llm', name: 'a' }, b: { kind: 'llm', name: 'b' } },
    }
    const out = formatCompareResult(r)
    expect(out).toContain('🅰 A wins')
    expect(out).toContain('A was more direct')
  })

  it('renders tie / inconclusive verdicts', () => {
    const r: CompareResult = {
      a: side('A', true, 'a'),
      b: side('B', true, 'b'),
      judge: { pick: 'tie', reason: 'equivalent quality', backendName: 'x', durationMs: 1 },
      input: { prompt: 'hi', a: { kind: 'llm', name: 'a' }, b: { kind: 'llm', name: 'b' } },
    }
    expect(formatCompareResult(r)).toContain('🤝 tie')

    r.judge = { pick: 'inconclusive', reason: 'garbled', backendName: 'x', durationMs: 1 }
    expect(formatCompareResult(r)).toContain('🤷 inconclusive')
  })
})

describe('runRouterCompare', () => {
  beforeEach(() => {
    // Reset any process env that might leak between tests.
  })

  it('throws on empty prompt', async () => {
    let threw = false
    try {
      await runRouterCompare({
        prompt: '   ',
        a: { kind: 'llm', name: 'cheap' },
        b: { kind: 'llm', name: 'evaluator' },
      })
    } catch { threw = true }
    expect(threw).toBe(true)
  })

  it('returns ok=false for both sides when no backends are registered', async () => {
    const r = await runRouterCompare({
      prompt: 'test prompt',
      a: { kind: 'llm', name: 'nonexistent-role' },
      b: { kind: 'backend', name: 'nonexistent-backend' },
    })
    expect(r.a.ok).toBe(false)
    expect(r.b.ok).toBe(false)
    expect(r.a.error).toContain('no native LLM backend')
    expect(r.b.error).toContain('no LLM backend named')
    // judge should be absent because both sides failed
    expect(r.judge).toBeUndefined()
  })

  it('handles agent kind with unregistered agent gracefully', async () => {
    const r = await runRouterCompare({
      prompt: 'test prompt',
      a: { kind: 'agent', name: 'totally-fake-agent' },
      b: { kind: 'llm', name: 'fake-role' },
      perSideTimeoutMs: 1_000,
    })
    expect(r.a.ok).toBe(false)
    expect(r.b.ok).toBe(false)
  })
})
