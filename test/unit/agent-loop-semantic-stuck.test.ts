// v1.2.122 — semantic stuck-loop:
//   - extractSalientStrings extracts ≥8-char strings from argsKey JSON
//   - isSemanticStuckLoop fires when 3 different tools share a salient
//     string in their argsKey
//   - It does NOT fire when names are identical (isStuckLoop's job)
//   - It does NOT fire when salient strings are too short (≤7 chars)
//   - Env IMHUB_NATIVE_SEMANTIC_STUCK_LOOP=off disables in the loop

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  isSemanticStuckLoop,
  extractSalientStrings,
} from '../../src/core/llm/agent-loop.js'
import {
  LlmProvider,
  type ChatOptions,
  type ChatResult,
  type LlmMessage,
  type NormalizedOptions,
} from '../../src/core/llm/provider-base.js'
import { runAgentLoop } from '../../src/core/llm/agent-loop.js'
import type { DispatcherResult } from '../../src/core/llm/tool-dispatcher.js'

describe('extractSalientStrings (v1.2.122)', () => {
  it('pulls out strings ≥ 8 chars from a JSON-stable argsKey', () => {
    const argsKey = '{"query":"aapl earnings Q3","topK":5,"format":"json"}'
    const out = extractSalientStrings(argsKey)
    expect(out.has('aapl earnings Q3')).toBe(true)
    // "json" is too short
    expect(out.has('json')).toBe(false)
  })

  it('ignores short strings (< 8 chars)', () => {
    const argsKey = '{"path":"/tmp/x","mode":"r"}'
    // "/tmp/x" is only 6 chars, "r" is 1
    const out = extractSalientStrings(argsKey)
    expect(out.size).toBe(0)
  })

  it('handles embedded escapes without breaking', () => {
    const argsKey = '{"text":"hello\\"world","x":"yyyyyyyy"}'
    const out = extractSalientStrings(argsKey)
    expect(out.size).toBeGreaterThan(0)
  })
})

describe('isSemanticStuckLoop (v1.2.122)', () => {
  function rep(name: string, argsKey: string) {
    return { name, argsKey }
  }

  it('fires when 3 different tools share the same long argument value', () => {
    const reports = [
      rep('native_web_search', '{"query":"aapl Q3 earnings call transcript"}'),
      rep('mcp__tavily',       '{"query":"aapl Q3 earnings call transcript"}'),
      rep('native_exec',       '{"command":"curl https://x.example/aapl Q3 earnings call transcript"}'),
    ]
    expect(isSemanticStuckLoop(reports)).toBe(true)
  })

  it('does NOT fire when all 3 are the same tool name (isStuckLoop covers it)', () => {
    const reports = [
      rep('native_web_search', '{"query":"aapl earnings transcript"}'),
      rep('native_web_search', '{"query":"aapl earnings transcript"}'),
      rep('native_web_search', '{"query":"aapl earnings transcript"}'),
    ]
    expect(isSemanticStuckLoop(reports)).toBe(false)
  })

  it('does NOT fire when salient strings differ', () => {
    const reports = [
      rep('native_web_search', '{"query":"meta Q3 earnings"}'),
      rep('mcp__tavily',       '{"query":"apple Q3 earnings"}'),
      rep('native_exec',       '{"command":"curl https://x.example/different"}'),
    ]
    expect(isSemanticStuckLoop(reports)).toBe(false)
  })

  it('does NOT fire on < 3 entries', () => {
    expect(isSemanticStuckLoop([])).toBe(false)
    expect(isSemanticStuckLoop([rep('a', '{"q":"longgggggg"}')])).toBe(false)
  })

  it('considers the LAST 3 entries (earlier ones are ignored)', () => {
    const reports = [
      // earlier irrelevant calls
      rep('foo', '{"x":"random123"}'),
      rep('bar', '{"y":"other456"}'),
      // the 3 we care about — all share salient string
      rep('native_web_search', '{"query":"target keyword phrase Z"}'),
      rep('mcp__tavily',       '{"query":"target keyword phrase Z"}'),
      rep('native_exec',       '{"command":"echo target keyword phrase Z"}'),
    ]
    expect(isSemanticStuckLoop(reports)).toBe(true)
  })
})

// Integration: the loop honours IMHUB_NATIVE_SEMANTIC_STUCK_LOOP=off.
class ScriptedProvider extends LlmProvider {
  private readonly script: ChatResult[]
  public chatCalls = 0
  constructor(script: ChatResult[]) {
    super({ name: 'scripted', model: 'stub-m', providerType: 'stub' })
    this.script = script
  }
  override async chat(_m: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.chatCalls += 1
    const next = this.script.shift()
    if (!next) throw new Error('script exhausted')
    if (opts.onUsage && next.usage) { try { opts.onUsage(next.usage) } catch { /* */ } }
    return next
  }
  protected async _callApi(_m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal): Promise<ChatResult> {
    throw new Error('unused')
  }
}

describe('runAgentLoop — semantic stuck-loop integration (v1.2.122)', () => {
  const saved = process.env.IMHUB_NATIVE_SEMANTIC_STUCK_LOOP
  beforeEach(() => { delete process.env.IMHUB_NATIVE_SEMANTIC_STUCK_LOOP })
  afterEach(() => {
    if (saved === undefined) delete process.env.IMHUB_NATIVE_SEMANTIC_STUCK_LOOP
    else process.env.IMHUB_NATIVE_SEMANTIC_STUCK_LOOP = saved
  })

  it('fires + early-terminates with finishReason=stuck_loop', async () => {
    // Three turns, each emits ONE tool call with a different tool name
    // but a shared salient string. After the 3rd, semantic-stuck-loop
    // should fire and end the run.
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'tool_a', arguments: { query: 'unique search target xyzzy' } }],
        usage: {}, modelUsed: 'stub-m',
      },
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c2', name: 'tool_b', arguments: { query: 'unique search target xyzzy' } }],
        usage: {}, modelUsed: 'stub-m',
      },
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c3', name: 'tool_c', arguments: { query: 'unique search target xyzzy' } }],
        usage: {}, modelUsed: 'stub-m',
      },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        { name: 'tool_a', description: '', parameters: { type: 'object', properties: {} } },
        { name: 'tool_b', description: '', parameters: { type: 'object', properties: {} } },
        { name: 'tool_c', description: '', parameters: { type: 'object', properties: {} } },
      ],
      dispatch: async () => ({ text: 'nothing useful', isError: false, source: 'stub' }),
    })
    expect(r.finishReason).toBe('stuck_loop')
    expect(r.toolCalls.length).toBe(3)
  })

  it('IMHUB_NATIVE_SEMANTIC_STUCK_LOOP=off disables the check', async () => {
    process.env.IMHUB_NATIVE_SEMANTIC_STUCK_LOOP = 'off'
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'tool_a', arguments: { query: 'duplicate string xyzzy' } }],
        usage: {}, modelUsed: 'stub-m',
      },
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c2', name: 'tool_b', arguments: { query: 'duplicate string xyzzy' } }],
        usage: {}, modelUsed: 'stub-m',
      },
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c3', name: 'tool_c', arguments: { query: 'duplicate string xyzzy' } }],
        usage: {}, modelUsed: 'stub-m',
      },
      // 4th turn lets the loop finalize normally if semantic stuck is off
      { text: 'done', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        { name: 'tool_a', description: '', parameters: { type: 'object', properties: {} } },
        { name: 'tool_b', description: '', parameters: { type: 'object', properties: {} } },
        { name: 'tool_c', description: '', parameters: { type: 'object', properties: {} } },
      ],
      dispatch: async () => ({ text: 'ok', isError: false, source: 'stub' }),
    })
    // With the check off, the loop continues to the 4th iter where the
    // provider emits a 'stop'.
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('done')
  })
})
