// v1.2.117 — locks the LLM length-truncation auto-recovery path.
//
// When `provider.chat()` returns `finishReason: 'length'` the loop
// must:
//   (a) auto-continue: push the partial assistant text into history
//       AS-IS and append a synthetic user message asking the model to
//       continue without repeating;
//   (b) accumulate partials into the returned `text` so the caller
//       gets partial1 + partial2 + … + final concatenated;
//   (c) cap retries at AGIM_NATIVE_LENGTH_RECOVERY_MAX (default 3)
//       to prevent obot's $0.91 retry-storm scenario;
//   (d) when length AND partial tool_calls arrive together, DROP the
//       tool_calls (do not execute a half-emitted JSON arg blob);
//   (e) when the cap is reached, fall through to the normal "early
//       terminate on non-tool_use" branch and surface finishReason
//       'length' with the full accumulated text.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  LlmProvider,
  type ChatOptions,
  type ChatResult,
  type LlmMessage,
  type NormalizedOptions,
} from '../../src/core/llm/provider-base.js'
import { runAgentLoop } from '../../src/core/llm/agent-loop.js'
import type { DispatcherResult } from '../../src/core/llm/tool-dispatcher.js'

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
  protected async _callApi(
    _m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal,
  ): Promise<ChatResult> { throw new Error('unused') }
}

describe('runAgentLoop — length-recovery (v1.2.117)', () => {
  // Cap is read from env at loop entry; tests overwrite per-case so
  // we can drive the boundary precisely without polluting other tests.
  const savedEnv = process.env.AGIM_NATIVE_LENGTH_RECOVERY_MAX
  beforeEach(() => { delete process.env.AGIM_NATIVE_LENGTH_RECOVERY_MAX })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGIM_NATIVE_LENGTH_RECOVERY_MAX
    else process.env.AGIM_NATIVE_LENGTH_RECOVERY_MAX = savedEnv
  })

  it('single length truncation auto-continues + concatenates partials', async () => {
    const provider = new ScriptedProvider([
      { text: 'partial one ', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'final tail.', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(provider.chatCalls).toBe(2)
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('partial one final tail.')
    // History on the second call must contain: original user, partial
    // assistant, recovery user message.
    const seen = provider.lastMessages!
    expect(seen.length).toBe(3)
    expect(seen[1]?.role).toBe('assistant')
    expect(seen[1]?.content).toBe('partial one ')
    expect(seen[2]?.role).toBe('user')
    expect(seen[2]?.content).toMatch(/cut off due to the output length limit/i)
  })

  it('chains across multiple length truncations under the cap', async () => {
    const provider = new ScriptedProvider([
      { text: 'A', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'B', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'C', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(provider.chatCalls).toBe(3)
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('ABC')
  })

  it('cap=3: 4th consecutive length surfaces finishReason=length with full prefix', async () => {
    // Force the cap explicitly even though 3 is the default — guard
    // against future default tweaks accidentally invalidating the test.
    process.env.AGIM_NATIVE_LENGTH_RECOVERY_MAX = '3'
    const provider = new ScriptedProvider([
      { text: 'A', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'B', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'C', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'D', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    // 1 initial + 3 recoveries = 4 chat calls total.
    expect(provider.chatCalls).toBe(4)
    expect(r.finishReason).toBe('length')
    // First 3 partials accumulated as prefix, 4th lands as the
    // result.text — all four concatenated.
    expect(r.text).toBe('ABCD')
  })

  it('cap=0 disables auto-continue entirely (back-compat escape hatch)', async () => {
    process.env.AGIM_NATIVE_LENGTH_RECOVERY_MAX = '0'
    const provider = new ScriptedProvider([
      { text: 'partial', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(provider.chatCalls).toBe(1)
    expect(r.finishReason).toBe('length')
    expect(r.text).toBe('partial')
  })

  it('length + partial tool_calls: drops the tool_calls, recovery prompt only', async () => {
    // Critical safety: a half-emitted JSON args blob in a length-
    // truncated response must NOT be dispatched (obot $0.91 disaster).
    let dispatchCalls = 0
    const provider = new ScriptedProvider([
      {
        text: 'about to call a tool',
        finishReason: 'length',
        toolCalls: [{ id: 'call_truncated', name: 'agim_read_file', arguments: { path: '/etc/host' } }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'recovered cleanly', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const dispatch = async (): Promise<DispatcherResult> => {
      dispatchCalls += 1
      return { text: 'should-never-fire', isError: false, source: 'stub' }
    }
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'agim_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
    })
    expect(dispatchCalls).toBe(0)             // tool_calls dropped
    expect(provider.chatCalls).toBe(2)
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('about to call a toolrecovered cleanly')
    expect(r.toolCalls.length).toBe(0)
  })

  it('non-length finish (e.g. stop) is untouched — no recovery, no concat', async () => {
    // Sanity: the recovery branch must not interfere with the
    // happy path.
    const provider = new ScriptedProvider([
      { text: 'short answer', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(provider.chatCalls).toBe(1)
    expect(r.finishReason).toBe('stop')
    expect(r.text).toBe('short answer')
  })

  // v1.2.132 regression — TCP drop before the first token of a stream
  // surfaces as `finishReason='length'` with `text=''` (the v1.2.123
  // graceful-degradation classifier). The recovery path used to push
  // `{ role: 'assistant', content: '' }` + the recovery user message,
  // which OpenAI-compat (DeepSeek) rejects with HTTP 400 "Invalid
  // assistant message: content or tool_calls must be set" on the very
  // next call. Pin: when partial is empty, skip the assistant push —
  // only the recovery user message goes in.
  it('empty partial (TCP drop pre-token) does NOT push empty assistant', async () => {
    const provider = new ScriptedProvider([
      // Truncation BEFORE first token landed → text empty.
      { text: '', finishReason: 'length', usage: {}, modelUsed: 'stub-m' },
      { text: 'continuation', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
    })
    expect(r.text).toBe('continuation')
    // History the continuation call saw — scan for the bad shape.
    const seen = provider.lastMessages!
    for (const m of seen) {
      if (m.role !== 'assistant') continue
      const empty = !m.content || m.content.length === 0
      const noTools = !m.toolCalls || m.toolCalls.length === 0
      expect(empty && noTools).toBe(false)
    }
    // The original user + the recovery user message both land; no
    // intervening empty assistant.
    const users = seen.filter((m) => m.role === 'user').map((m) => m.content)
    expect(users.length).toBe(2)
    expect(users[0]).toBe('go')
    expect(users[1]).toMatch(/cut off due to the output length limit/i)
  })
})
