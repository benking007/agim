import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  completeDeepSeekFim,
  createDeepSeekResponse,
  withChatPrefixAssistant,
} from './deepseek-api.js'

const originalFetch = globalThis.fetch

describe('deepseek-api', () => {
  beforeEach(() => { globalThis.fetch = originalFetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('builds chat prefix assistant message', () => {
    expect(withChatPrefixAssistant(
      [{ role: 'user', content: 'write sort' }],
      '```python\n',
    )).toEqual([
      { role: 'user', content: 'write sort' },
      { role: 'assistant', content: '```python\n', prefix: true },
    ])
  })

  it('POSTs FIM to beta /completions', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url)
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        model: 'deepseek-v4-pro',
        choices: [{ text: '  if a < 2: return a\n', finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const result = await completeDeepSeekFim(
      { apiKey: 'sk-test' },
      { model: 'deepseek-v4-pro', prompt: 'def fib(a):', suffix: '    return fib(a-1)+fib(a-2)' },
    )
    expect(seenUrl).toBe('https://api.deepseek.com/beta/completions')
    expect(seenBody.prompt).toBe('def fib(a):')
    expect(seenBody.suffix).toContain('fib(a-1)')
    expect(result.text).toContain('if a < 2')
  })

  it('POSTs Responses API to /responses', async () => {
    let seenUrl = ''
    globalThis.fetch = (async (url: string) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({
        id: 'resp_1',
        status: 'completed',
        model: 'deepseek-v4-flash',
        output_text: 'hello',
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const result = await createDeepSeekResponse(
      { apiKey: 'sk-test' },
      { model: 'deepseek-v4-flash', input: 'Hi', instructions: 'Be brief' },
    )
    expect(seenUrl).toBe('https://api.deepseek.com/responses')
    expect(result.outputText).toBe('hello')
    expect(result.usage?.reasoningTokens).toBe(1)
  })
})
