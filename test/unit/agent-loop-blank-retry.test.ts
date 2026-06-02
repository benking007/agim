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
    // v1.2.130 — second call must NOT include the empty assistant
    // turn (openai-compat rejects content:'' + no tool_calls). The
    // history is just the original user + the nudge user.
    const seen = provider.lastMessages!
    expect(seen.length).toBe(2)
    expect(seen[0]?.role).toBe('user')
    expect(seen[0]?.content).toBe('go')
    expect(seen[1]?.role).toBe('user')
    expect(seen[1]?.content).toMatch(/Your last response was empty/i)
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
    // v1.2.132 — empty partial is no longer persisted as an assistant
    // turn (would otherwise 400 the next openai-compat call). The
    // continuation call sees just [original_user, recovery_user].
    const seen = provider.lastMessages!
    expect(seen).toHaveLength(2)
    expect(seen[0]?.role).toBe('user')
    expect(seen[1]?.role).toBe('user')
    expect(seen[1]?.content).toMatch(/cut off due to the output length limit/i)
    expect(r.text).toBe('continuation')
  })

  // v1.2.130 regression — the v1.2.119 implementation pushed an empty
  // assistant placeholder ({ role: 'assistant', content: '' }) before
  // the user nudge. OpenAI Chat Completions (and DeepSeek) reject any
  // assistant message whose content is empty AND has no tool_calls
  // with HTTP 400 ("Invalid assistant message: content or tool_calls
  // must be set"). The retry path must NEVER emit such a turn.
  it('retry does NOT push an empty assistant placeholder (v1.2.130)', async () => {
    const provider = new ScriptedProvider([
      // First call: blank + no tool_calls → triggers retry.
      { text: '', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
      // Retry call: model finally responds.
      { text: 'OK then', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(r.text).toBe('OK then')
    // Inspect the messages the retry call saw.
    const seen = provider.lastMessages!
    // No assistant turn should have empty content + no tool_calls —
    // that's the exact shape openai-compat 400s on.
    for (const m of seen) {
      if (m.role !== 'assistant') continue
      const empty = !m.content || m.content.length === 0
      const noTools = !m.toolCalls || m.toolCalls.length === 0
      expect(empty && noTools).toBe(false)
    }
    // Belt-and-suspenders: the original prompt + the nudge are both
    // present as consecutive user messages — which is fine per spec.
    const users = seen.filter((m) => m.role === 'user').map((m) => m.content)
    expect(users.length).toBeGreaterThanOrEqual(2)
    expect(users[0]).toBe('go')
    expect(users[users.length - 1]).toMatch(/empty|nudge|没有/i)
  })
})
