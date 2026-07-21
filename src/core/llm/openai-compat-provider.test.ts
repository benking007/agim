// Unit tests for OpenAICompatProvider.
//
// We mock global fetch with bun's spy machinery so the tests are
// hermetic (no real network) and the assertions can pin the exact
// request body / headers the provider sends.

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { OpenAICompatProvider } from './openai-compat-provider.js'
import { LlmProviderError } from './provider-base.js'

const originalFetch = globalThis.fetch

function makeJsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
}

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('OpenAICompatProvider', () => {
  beforeEach(() => {
    // ensure mocks don't carry between tests
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('builds POST body with model + messages + configured temperature + max_tokens', async () => {
    const fetchSpy = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body.model).toBe('gpt-4.1')
      expect(body.temperature).toBe(0.2)
      expect(body.max_tokens).toBe(256)
      expect(Array.isArray(body.messages)).toBe(true)
      expect((body.messages as { role: string }[])[0].role).toBe('user')
      const headers = init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer sk-test')
      return makeJsonResponse({
        model: 'gpt-4.1',
        choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const p = new OpenAICompatProvider({
      name: 'test',
      model: 'gpt-4.1',
      apiKey: 'sk-test',
      defaultTemperature: 0.2,
      defaultMaxTokens: 256,
    })
    const result = await p.chat([{ role: 'user', content: 'hi' }])
    expect(result.text).toBe('hello world')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.totalTokens).toBe(7)
    expect(result.modelUsed).toBe('gpt-4.1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('omits temperature when neither call nor backend config set it', async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      expect(body.temperature).toBeUndefined()
      return makeJsonResponse({
        model: 'claude-sonnet-4',
        choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
    }) as unknown as typeof fetch

    const p = new OpenAICompatProvider({
      name: 'claude-compat',
      model: 'claude-sonnet-4',
      apiKey: 'sk-test',
      defaultMaxTokens: 256,
    })
    const result = await p.chat([{ role: 'user', content: 'ping' }])
    expect(result.text).toBe('pong')
  })

  it('falls back to OpenAI base URL when baseUrl unset', async () => {
    let seenUrl = ''
    globalThis.fetch = (async (url: string) => {
      seenUrl = url
      return makeJsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    await p.chat([{ role: 'user', content: 'x' }])
    expect(seenUrl).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('honours custom baseUrl (DeepSeek-style) and defaults thinking off', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url)
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return makeJsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({
      name: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
    })
    await p.chat([{ role: 'user', content: 'x' }])
    expect(seenUrl).toBe('https://api.deepseek.com/chat/completions')
    expect(seenBody.thinking).toEqual({ type: 'disabled' })
  })

  it('merges extraHeaders into request', async () => {
    let seenHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>
      return makeJsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({
      name: 'or',
      model: 'm',
      apiKey: 'k',
      extraHeaders: { 'HTTP-Referer': 'https://example.com', 'X-Title': 'agim' },
    })
    await p.chat([{ role: 'user', content: 'x' }])
    expect(seenHeaders['HTTP-Referer']).toBe('https://example.com')
    expect(seenHeaders['X-Title']).toBe('agim')
  })

  it('retries once on 429 then succeeds', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) {
        return new Response('rate limited', { status: 429 })
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'second time lucky' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({
      name: 't', model: 'm', apiKey: 'k', retryOnTransient: 1,
    })
    const result = await p.chat([{ role: 'user', content: 'x' }])
    expect(result.text).toBe('second time lucky')
    expect(calls).toBe(2)
  })

  it('surfaces non-retryable HTTP error as LlmProviderError', async () => {
    globalThis.fetch = (async () => {
      return new Response('bad token', { status: 401 })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(LlmProviderError)
  })

  it('respects timeoutMs by aborting', async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      // Hang forever unless aborted; resolve when the signal fires.
      return new Promise<Response>((_, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }, { once: true })
      })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    await expect(
      p.chat([{ role: 'user', content: 'x' }], { timeoutMs: 50 }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('streams text deltas via SSE', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]
    globalThis.fetch = (async () => makeSseResponse(sse)) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    const chunks: string[] = []
    let lastFinish: string | null | undefined
    let lastUsageTokens: number | undefined
    for await (const c of p.chatStream([{ role: 'user', content: 'x' }])) {
      if (c.textDelta) chunks.push(c.textDelta)
      if (c.finishReason !== undefined) lastFinish = c.finishReason
      if (c.usage?.totalTokens) lastUsageTokens = c.usage.totalTokens
    }
    expect(chunks.join('')).toBe('Hello')
    expect(lastFinish).toBe('stop')
    expect(lastUsageTokens).toBe(5)
  })

  it('isConfigured() flips on apiKey presence', () => {
    const a = new OpenAICompatProvider({ name: 'a', model: 'm' })
    const b = new OpenAICompatProvider({ name: 'b', model: 'm', apiKey: 'k' })
    expect(a.isConfigured()).toBe(false)
    expect(b.isConfigured()).toBe(true)
  })

  it('passes onUsage callback when usage info is returned', async () => {
    globalThis.fetch = (async () => makeJsonResponse({
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0042 },
    })) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    let seenCost: number | undefined
    await p.chat([{ role: 'user', content: 'x' }], {
      onUsage: (u) => { seenCost = u.costUsd },
    })
    expect(seenCost).toBe(0.0042)
  })

  it('prepends system message via opts.system when no system message present', async () => {
    let sentMessages: Array<{ role: string; content: string }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }
      sentMessages = body.messages
      return makeJsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    await p.chat([{ role: 'user', content: 'hi' }], { system: 'be terse' })
    expect(sentMessages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
  })
  it('round-trips DeepSeek reasoning_content on assistant tool-call turns', async () => {
    let sentMessages: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> }
      sentMessages = body.messages
      return makeJsonResponse({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch

    const p = new OpenAICompatProvider({ name: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'k' })
    await p.chat([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'thinking trace',
        toolCalls: [{ id: 'call_1', name: 'list_files', arguments: { path: '/tmp' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'ok' },
    ])

    const assistant = sentMessages[1] as { reasoning_content?: string; tool_calls: unknown[] }
    expect(assistant.reasoning_content).toBe('thinking trace')
    expect(assistant.tool_calls).toHaveLength(1)
  })

  it('extracts reasoning_content from provider response', async () => {
    globalThis.fetch = (async () => makeJsonResponse({
      choices: [{
        message: {
          content: 'answer',
          reasoning_content: 'chain-of-thought',
          tool_calls: [{
            id: 'call_x',
            type: 'function',
            function: { name: 'do_thing', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })) as unknown as typeof fetch

    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    const result = await p.chat([{ role: 'user', content: 'go' }])
    expect(result.reasoningContent).toBe('chain-of-thought')
    expect(result.toolCalls).toHaveLength(1)
  })

})


describe('OpenAICompatProvider — tool calls (Stage 2)', () => {
  beforeEach(() => { globalThis.fetch = originalFetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('serializes tools[] and tool_choice into request body', async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string) as Record<string, unknown>
      return makeJsonResponse({
        model: 'gpt-4.1',
        choices: [{
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
      })
    }) as unknown as typeof fetch

    const p = new OpenAICompatProvider({ name: 't', model: 'gpt-4.1', apiKey: 'k' })
    await p.chat([{ role: 'user', content: 'list files' }], {
      tools: [{
        name: 'list_files',
        description: 'Lists files in a directory',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
      toolChoice: 'auto',
    })

    expect(Array.isArray(sentBody.tools)).toBe(true)
    const tools = sentBody.tools as Array<{ type: string; function: { name: string; parameters: { properties: Record<string, unknown> } } }>
    expect(tools[0].type).toBe('function')
    expect(tools[0].function.name).toBe('list_files')
    expect(tools[0].function.parameters.properties.path).toBeDefined()
    expect(sentBody.tool_choice).toBe('auto')
  })

  it('parses tool_calls from response into ChatResult.toolCalls', async () => {
    globalThis.fetch = (async () => makeJsonResponse({
      model: 'gpt-4.1',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: {
              name: 'list_files',
              arguments: '{"path":"/tmp"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })) as unknown as typeof fetch

    const p = new OpenAICompatProvider({ name: 't', model: 'gpt-4.1', apiKey: 'k' })
    const result = await p.chat([{ role: 'user', content: 'list /tmp' }], {
      tools: [{
        name: 'list_files',
        description: '',
        parameters: { type: 'object', properties: {} },
      }],
    })

    expect(result.finishReason).toBe('tool_use')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls?.[0].id).toBe('call_abc')
    expect(result.toolCalls?.[0].name).toBe('list_files')
    expect(result.toolCalls?.[0].arguments.path).toBe('/tmp')
    expect(result.text).toBe('')
  })

  it('surfaces malformed JSON arguments via argumentsRaw', async () => {
    globalThis.fetch = (async () => makeJsonResponse({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_x',
            type: 'function',
            function: { name: 'do_thing', arguments: '{not valid json' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })) as unknown as typeof fetch

    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    const result = await p.chat([{ role: 'user', content: 'go' }], {
      tools: [{ name: 'do_thing', description: '', parameters: {} }],
    })
    expect(result.toolCalls?.[0].arguments).toEqual({})
    expect(result.toolCalls?.[0].argumentsRaw).toBe('{not valid json')
  })

  it('round-trips assistant message with toolCalls + tool result back to API', async () => {
    let sentMessages: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> }
      sentMessages = body.messages
      return makeJsonResponse({
        choices: [{ message: { content: 'all done' }, finish_reason: 'stop' }],
      })
    }) as unknown as typeof fetch

    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    await p.chat([
      { role: 'user', content: 'list /tmp' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_abc', name: 'list_files', arguments: { path: '/tmp' } }],
      },
      { role: 'tool', toolCallId: 'call_abc', content: 'a\nb\nc' },
    ])

    // assistant turn carries tool_calls + content=null per OpenAI spec
    const assistant = sentMessages[1] as { role: string; content: unknown; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toBeNull()
    expect(assistant.tool_calls[0].id).toBe('call_abc')
    expect(assistant.tool_calls[0].function.name).toBe('list_files')
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ path: '/tmp' })

    // tool turn carries tool_call_id + content
    const toolMsg = sentMessages[2] as { role: string; tool_call_id: string; content: string }
    expect(toolMsg.role).toBe('tool')
    expect(toolMsg.tool_call_id).toBe('call_abc')
    expect(toolMsg.content).toBe('a\nb\nc')
  })

  it('forwards toolChoice={type:tool, name} as OpenAI function shape', async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string) as Record<string, unknown>
      return makeJsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
    }) as unknown as typeof fetch
    const p = new OpenAICompatProvider({ name: 't', model: 'm', apiKey: 'k' })
    await p.chat([{ role: 'user', content: 'x' }], {
      tools: [{ name: 'pick', description: '', parameters: {} }],
      toolChoice: { type: 'tool', name: 'pick' },
    })
    expect(sentBody.tool_choice).toEqual({ type: 'function', function: { name: 'pick' } })
  })
})
