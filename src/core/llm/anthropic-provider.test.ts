// Unit tests for AnthropicProvider — mirrors openai-compat-provider's
// suite but covers the Messages-API-shaped wire format.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AnthropicProvider } from './anthropic-provider.js'
import { LlmProviderError } from './provider-base.js'

const originalFetch = globalThis.fetch

function makeJsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
}

beforeEach(() => { globalThis.fetch = originalFetch })
afterEach(() => { globalThis.fetch = originalFetch })

describe('AnthropicProvider — basics', () => {
  it('sends model + max_tokens + content-block messages + system top-level', async () => {
    let sentUrl = ''
    let sentBody: Record<string, unknown> = {}
    let sentHeaders: Record<string, string> = {}
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sentUrl = url
      sentBody = JSON.parse(init.body as string) as Record<string, unknown>
      sentHeaders = init.headers as Record<string, string>
      return makeJsonResponse({
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hello back' }],
        usage: { input_tokens: 8, output_tokens: 3 },
      })
    }) as unknown as typeof fetch

    const p = new AnthropicProvider({
      name: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'sk-ant-test',
      defaultTemperature: 0.2,
      defaultMaxTokens: 256,
    })
    const result = await p.chat(
      [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    )

    expect(sentUrl).toBe('https://api.anthropic.com/v1/messages')
    expect(sentBody.model).toBe('claude-3-5-sonnet-20241022')
    expect(sentBody.system).toBe('be terse')
    const msgs = sentBody.messages as Array<{ role: string; content: string }>
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('hi')
    expect(sentBody.max_tokens).toBe(256)
    expect(sentHeaders['x-api-key']).toBe('sk-ant-test')
    expect(sentHeaders['anthropic-version']).toBe('2023-06-01')

    expect(result.text).toBe('hello back')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.promptTokens).toBe(8)
    expect(result.usage.completionTokens).toBe(3)
    expect(result.usage.totalTokens).toBe(11)
  })

  it('extracts text from multi-block content', async () => {
    globalThis.fetch = (async () => makeJsonResponse({
      content: [
        { type: 'text', text: 'part 1 ' },
        { type: 'text', text: 'part 2' },
      ],
      stop_reason: 'end_turn',
    })) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
    const r = await p.chat([{ role: 'user', content: 'x' }])
    expect(r.text).toBe('part 1 part 2')
  })

  it('honours custom baseUrl + extraHeaders + apiVersion', async () => {
    let sentUrl = ''
    let sentHeaders: Record<string, string> = {}
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sentUrl = url
      sentHeaders = init.headers as Record<string, string>
      return makeJsonResponse({ content: [], stop_reason: 'end_turn' })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({
      name: 'gw', model: 'm', apiKey: 'k',
      baseUrl: 'https://proxy.example.com/anthropic',
      apiVersion: '2026-01-01',
      extraHeaders: { 'X-Custom': 'yes' },
    })
    await p.chat([{ role: 'user', content: 'x' }])
    expect(sentUrl).toBe('https://proxy.example.com/anthropic/v1/messages')
    expect(sentHeaders['anthropic-version']).toBe('2026-01-01')
    expect(sentHeaders['X-Custom']).toBe('yes')
  })

  it('retries once on 429 then succeeds', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return new Response('rate limited', { status: 429 })
      return makeJsonResponse({
        content: [{ type: 'text', text: 'second time lucky' }],
        stop_reason: 'end_turn',
      })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k', retryOnTransient: 1 })
    const r = await p.chat([{ role: 'user', content: 'x' }])
    expect(r.text).toBe('second time lucky')
    expect(calls).toBe(2)
  })

  it('non-retryable HTTP error → LlmProviderError', async () => {
    globalThis.fetch = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(LlmProviderError)
  })
})

describe('AnthropicProvider — tool calls', () => {
  it('serializes tools with input_schema + tool_choice auto', async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string) as Record<string, unknown>
      return makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
    await p.chat([{ role: 'user', content: 'go' }], {
      tools: [{
        name: 'do_thing',
        description: 'Does a thing',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      }],
      toolChoice: 'auto',
    })
    const tools = sentBody.tools as Array<{ name: string; input_schema: { properties: Record<string, unknown> } }>
    expect(tools[0].name).toBe('do_thing')
    expect(tools[0].input_schema.properties.x).toBeDefined()
    expect(sentBody.tool_choice).toEqual({ type: 'auto' })
  })

  it('parses tool_use blocks from response', async () => {
    globalThis.fetch = (async () => makeJsonResponse({
      content: [
        { type: 'text', text: 'I will use a tool' },
        { type: 'tool_use', id: 'toolu_01', name: 'do_thing', input: { x: 'hello' } },
      ],
      stop_reason: 'tool_use',
    })) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
    const r = await p.chat([{ role: 'user', content: 'go' }], {
      tools: [{ name: 'do_thing', description: '', parameters: {} }],
    })
    expect(r.text).toBe('I will use a tool')
    expect(r.finishReason).toBe('tool_use')
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls?.[0].id).toBe('toolu_01')
    expect(r.toolCalls?.[0].name).toBe('do_thing')
    expect(r.toolCalls?.[0].arguments).toEqual({ x: 'hello' })
  })

  it('round-trips assistant tool_use + user tool_result back to API', async () => {
    let sentMessages: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<Record<string, unknown>> }
      sentMessages = body.messages
      return makeJsonResponse({
        content: [{ type: 'text', text: 'all done' }],
        stop_reason: 'end_turn',
      })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
    await p.chat([
      { role: 'user', content: 'list /tmp' },
      {
        role: 'assistant',
        content: 'sure, calling',
        toolCalls: [{ id: 'toolu_01', name: 'list_files', arguments: { path: '/tmp' } }],
      },
      { role: 'tool', toolCallId: 'toolu_01', content: 'a\nb\nc' },
    ])

    // assistant turn: content array with text + tool_use block
    const assistant = sentMessages[1] as { role: string; content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> }
    expect(assistant.role).toBe('assistant')
    expect(Array.isArray(assistant.content)).toBe(true)
    expect(assistant.content[0]).toMatchObject({ type: 'text', text: 'sure, calling' })
    expect(assistant.content[1]).toMatchObject({
      type: 'tool_use', id: 'toolu_01', name: 'list_files', input: { path: '/tmp' },
    })

    // tool turn → user role with tool_result block
    const toolMsg = sentMessages[2] as { role: string; content: Array<{ type: string; tool_use_id: string; content: string }> }
    expect(toolMsg.role).toBe('user')
    expect(toolMsg.content[0]).toMatchObject({
      type: 'tool_result', tool_use_id: 'toolu_01', content: 'a\nb\nc',
    })
  })

  it('toolChoice required → {type:any}, specific tool → {type:tool, name}', async () => {
    const sentBodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(init.body as string) as Record<string, unknown>)
      return makeJsonResponse({ content: [], stop_reason: 'end_turn' })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
    await p.chat([{ role: 'user', content: 'x' }], {
      tools: [{ name: 'pick', description: '', parameters: {} }],
      toolChoice: 'required',
    })
    await p.chat([{ role: 'user', content: 'x' }], {
      tools: [{ name: 'pick', description: '', parameters: {} }],
      toolChoice: { type: 'tool', name: 'pick' },
    })
    expect(sentBodies[0].tool_choice).toEqual({ type: 'any' })
    expect(sentBodies[1].tool_choice).toEqual({ type: 'tool', name: 'pick' })
  })

  it('joins multiple leading system messages with blank line', async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string) as Record<string, unknown>
      return makeJsonResponse({ content: [], stop_reason: 'end_turn' })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
    await p.chat([
      { role: 'system', content: 'first rule' },
      { role: 'system', content: 'second rule' },
      { role: 'user', content: 'hi' },
    ])
    expect(sentBody.system).toBe('first rule\n\nsecond rule')
    const msgs = sentBody.messages as Array<{ role: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
  })

  it('isConfigured() flips on apiKey presence', () => {
    const a = new AnthropicProvider({ name: 'a', model: 'm' })
    const b = new AnthropicProvider({ name: 'b', model: 'm', apiKey: 'k' })
    expect(a.isConfigured()).toBe(false)
    expect(b.isConfigured()).toBe(true)
  })

  it('mapStopReason: end_turn=stop, max_tokens=length, tool_use=tool_use', async () => {
    const cases: Array<[string, string]> = [
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool_use'],
      ['something_new', 'unknown'],
    ]
    for (const [raw, expected] of cases) {
      globalThis.fetch = (async () => makeJsonResponse({
        content: [{ type: 'text', text: '' }],
        stop_reason: raw,
      })) as unknown as typeof fetch
      const p = new AnthropicProvider({ name: 'c', model: 'm', apiKey: 'k' })
      const r = await p.chat([{ role: 'user', content: 'x' }])
      expect(r.finishReason).toBe(expected as 'stop' | 'tool_use' | 'length' | 'unknown')
    }
  })
})
