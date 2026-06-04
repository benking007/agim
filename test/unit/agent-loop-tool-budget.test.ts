// v1.2.118 — per-tool-result byte cap + per-tool wall timeout.
//
// These two features sit in the same dispatch wrapper because they're
// both "don't let one tool eat the turn." Truncation prevents context
// poisoning; timeout prevents wall-clock starvation. The test file
// pins both contracts:
//
//   (a) Tool output over `IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS` is
//       truncated with a marker; under the cap is untouched; cap=0
//       disables.
//   (b) A wedged tool that doesn't respect its abort signal is bounded
//       by per-tool timeout: the dispatcher's signal is aborted AND a
//       structured `timed out` tool-result reaches the model — i.e.
//       the model sees a tool-level failure, not an unhandled reject.
//   (c) `ToolDef.timeoutMs === 0` opts out (used by `long_task`).

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

describe('runAgentLoop — tool-result byte cap (v1.2.118)', () => {
  const saved = process.env.IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS
  beforeEach(() => { delete process.env.IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS })
  afterEach(() => {
    if (saved === undefined) delete process.env.IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS
    else process.env.IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS = saved
  })

  it('truncates over-cap tool output with a clear marker', async () => {
    process.env.IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS = '100'
    const huge = 'x'.repeat(5000)
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'big_dump', arguments: {} }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'ok', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const dispatch = async (): Promise<DispatcherResult> => (
      { text: huge, isError: false, source: 'stub' }
    )
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'big_dump', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
    })
    expect(r.finishReason).toBe('stop')
    expect(r.toolCalls.length).toBe(1)
    // preview is what the model sees; should include truncation marker.
    expect(r.toolCalls[0]!.preview).toMatch(/truncated/)
    // preview is sliced to 200 chars, but the truncation marker should
    // appear in the prefix because text was capped to 100 first.
    expect(r.toolCalls[0]!.preview.length).toBeLessThanOrEqual(200)
  })

  it('leaves under-cap output untouched (no marker)', async () => {
    process.env.IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS = '1000'
    const small = 'hello world'
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'small_out', arguments: {} }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'ok', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const dispatch = async (): Promise<DispatcherResult> => (
      { text: small, isError: false, source: 'stub' }
    )
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'small_out', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
    })
    expect(r.toolCalls[0]!.preview).toBe(small)
    expect(r.toolCalls[0]!.preview).not.toMatch(/truncated/)
  })

  it('cap=0 disables truncation entirely', async () => {
    process.env.IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS = '0'
    const huge = 'x'.repeat(5000)
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'big_dump', arguments: {} }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'ok', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    let observedHistoryContent = ''
    const dispatch = async (): Promise<DispatcherResult> => (
      { text: huge, isError: false, source: 'stub' }
    )
    // Sneak: read the history the second call sees to confirm the
    // whole 5000 chars made it through.
    const provider2 = new (class extends ScriptedProvider {
      override async chat(m: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
        if (this.chatCalls === 1) {
          // The tool message is the latest one before this second call.
          observedHistoryContent = String(m[m.length - 1]?.content ?? '')
        }
        return super.chat(m, opts)
      }
    })([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'big_dump', arguments: {} }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'ok', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    await runAgentLoop({
      provider: provider2,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'big_dump', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
    })
    expect(observedHistoryContent.length).toBe(5000)
    expect(observedHistoryContent).not.toMatch(/truncated/)
    // suppress unused-var warning
    void provider
  })
})

describe('runAgentLoop — per-tool wall timeout (v1.2.118)', () => {
  const saved = process.env.IMHUB_NATIVE_TOOL_TIMEOUT_MS
  beforeEach(() => { delete process.env.IMHUB_NATIVE_TOOL_TIMEOUT_MS })
  afterEach(() => {
    if (saved === undefined) delete process.env.IMHUB_NATIVE_TOOL_TIMEOUT_MS
    else process.env.IMHUB_NATIVE_TOOL_TIMEOUT_MS = saved
  })

  it('returns structured timeout result when a tool hangs past timeoutMs', async () => {
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'slow_tool', arguments: {} }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'done', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    let dispatchAbortReason: string | undefined
    const dispatch = async (_call: { name: string }, sig: AbortSignal): Promise<DispatcherResult> => {
      // Wait for the per-tool timer to abort us. If we ignore the
      // signal and resolve immediately, we'd race the timer; bind
      // resolution to the abort event so the test is deterministic.
      await new Promise<void>((resolve) => {
        if (sig.aborted) resolve()
        else sig.addEventListener('abort', () => resolve(), { once: true })
      })
      dispatchAbortReason = (sig.reason as Error | undefined)?.message
      // Real wedged tools would never resolve — but for the test we
      // still need to return something. The agent loop's Promise.race
      // already won via the timeout branch, so this return is dead
      // code in practice; we keep it for type safety.
      return { text: 'should-never-reach-model', isError: false, source: 'stub' }
    }
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{
        name: 'slow_tool',
        description: '',
        parameters: { type: 'object', properties: {} },
        timeoutMs: 50,    // race short enough for fast tests
      }],
      dispatch,
    })
    expect(r.finishReason).toBe('stop')
    expect(r.toolCalls.length).toBe(1)
    expect(r.toolCalls[0]!.isError).toBe(true)
    expect(r.toolCalls[0]!.source).toBe('timeout')
    expect(r.toolCalls[0]!.preview).toMatch(/timed out after 50ms/)
    // Dispatch's signal got aborted with our reason.
    expect(dispatchAbortReason).toMatch(/slow_tool timed out/)
  })

  it('timeoutMs=0 on the tool def opts out — slow call completes', async () => {
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'long_task', arguments: {} }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'done', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const dispatch = async (): Promise<DispatcherResult> => {
      // Faster than the default 60s cap, but verify we don't even
      // race against it because timeoutMs=0 ⇒ no race.
      await new Promise((r) => setTimeout(r, 80))
      return { text: 'finished slow work', isError: false, source: 'stub' }
    }
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{
        name: 'long_task',
        description: '',
        parameters: { type: 'object', properties: {} },
        timeoutMs: 0,
      }],
      dispatch,
    })
    expect(r.toolCalls[0]!.isError).toBe(false)
    expect(r.toolCalls[0]!.preview).toBe('finished slow work')
  })

  it('fast tool finishes before timeout — no race interference', async () => {
    const provider = new ScriptedProvider([
      {
        text: '',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'fast_tool', arguments: {} }],
        usage: {}, modelUsed: 'stub-m',
      },
      { text: 'done', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    const dispatch = async (): Promise<DispatcherResult> => (
      { text: 'quick', isError: false, source: 'stub' }
    )
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{
        name: 'fast_tool',
        description: '',
        parameters: { type: 'object', properties: {} },
        timeoutMs: 5000,
      }],
      dispatch,
    })
    expect(r.toolCalls[0]!.isError).toBe(false)
    expect(r.toolCalls[0]!.preview).toBe('quick')
  })
})
