// v1.2.119 — intra-loop blank-response retry.
//
// Pins:
//   (a) provider returns finishReason='stop' with empty text AND no
//       tool_calls → loop pushes a synthetic user nudge and retries.
//   (b) retry cap is IMHUB_NATIVE_BLANK_RETRY_MAX (default 2).
//   (c) cap=0 disables (back-compat with pre-1.2.119).
//   (d) does NOT trigger when tool_calls are present (that's the
//       v1.2.94 post-loop path, not this one).
//   (e) finishReason='length' takes priority over the blank check
//       (it has text; treat as truncation, not blank).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  LlmProvider,
  type ChatOptions,
  type ChatResult,
  type ChatStreamChunk,
  type LlmMessage,
  type NormalizedOptions,
} from '../../src/core/llm/provider-base.js'
import { runAgentLoop } from '../../src/core/llm/agent-loop.js'

class ScriptedProvider extends LlmProvider {
  private readonly script: ChatResult[]
  public chatCalls = 0
  public lastMessages: LlmMessage[] | null = null
  constructor(script: ChatResult[]) {
    super({ name: 'scripted', model: 'stub-m', providerType: 'stub' })
    this.script = script
  }
  override async chat(m: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.chatCalls += 1
    this.lastMessages = m
    const next = this.script.shift()
    if (!next) throw new Error('script exhausted')
    if (opts.onUsage && next.usage) { try { opts.onUsage(next.usage) } catch { /* */ } }
    return next
  }
  override async *chatStream(_m: LlmMessage[], _opts: ChatOptions = {}): AsyncIterable<ChatStreamChunk> {
    throw new Error('streaming not used')
  }
  protected async _callApi(_m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal): Promise<ChatResult> {
    throw new Error('unused')
  }
}

describe('runAgentLoop — blank-response intra-loop retry (v1.2.119)', () => {
  const saved = process.env.IMHUB_NATIVE_BLANK_RETRY_MAX
  beforeEach(() => { delete process.env.IMHUB_NATIVE_BLANK_RETRY_MAX })
  afterEach(() => {
    if (saved === undefined) delete process.env.IMHUB_NATIVE_BLANK_RETRY_MAX
    else process.env.IMHUB_NATIVE_BLANK_RETRY_MAX = saved
  })

  it('one blank → nudges → recovers in the next iter', async () => {
    const provider = new ScriptedProvider([
      { text: '', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
      { text: 'recovered answer', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(provider.chatCalls).toBe(2)
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('recovered answer')
    // Second call must have seen: original user, empty assistant, nudge user.
    const seen = provider.lastMessages!
    expect(seen.length).toBe(3)
    expect(seen[1]?.role).toBe('assistant')
    expect(seen[1]?.content).toBe('')
    expect(seen[2]?.role).toBe('user')
    expect(seen[2]?.content).toMatch(/Your last response was empty/i)
  })

  it('blank past the cap → returns final blank result + reports', async () => {
    process.env.IMHUB_NATIVE_BLANK_RETRY_MAX = '2'
    const provider = new ScriptedProvider([
      { text: '', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
      { text: '', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
      { text: '', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    // 1 initial + 2 retries = 3 chat calls, then cap blocks further;
    // 3rd is still blank → falls through to early-terminate.
    expect(provider.chatCalls).toBe(3)
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('')
  })

  it('cap=0 disables retry entirely (back-compat)', async () => {
    process.env.IMHUB_NATIVE_BLANK_RETRY_MAX = '0'
    const provider = new ScriptedProvider([
      { text: '', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(provider.chatCalls).toBe(1)
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('')
  })

  it('does NOT trigger when tool_calls are present (handled post-loop)', async () => {
    // Empty text + tool_calls present + finishReason='tool_use' →
    // normal tool-use iteration, not the blank-retry path.
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'native_read_file', arguments: { path: '/tmp/x' } }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'done', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'native_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch: async () => ({ text: 'file content', isError: false, source: 'stub' }),
    })
    // No retry should have fired — exactly 2 chat calls (the iter
    // that emitted the tool_call + the iter that finalized).
    expect(provider.chatCalls).toBe(2)
    expect(r.toolCalls.length).toBe(1)
    expect(r.text).toBe('done')
  })

  it('length-truncated text takes priority over blank-retry', async () => {
    // finishReason='length' with empty text is malformed but possible;
    // length-recovery should fire (not blank-retry), because the
    // semantics differ ("truncated" vs "model produced nothing").
    const provider = new ScriptedProvider([
      { text: '', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'continuation', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    // Length-recovery message — distinct from blank nudge.
    const seen = provider.lastMessages!
    expect(seen[2]?.content).toMatch(/cut off due to the output length limit/i)
    expect(r.text).toBe('continuation')
  })
})
