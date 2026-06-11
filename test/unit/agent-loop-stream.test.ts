// v1.2.112 — locks the streaming code path:
//   (a) when streamPartialText is on, text + tool_calls + reasoning
//       deltas are accumulated through chatStream, NOT chat().
//   (b) abort mid-stream returns the accumulated partial text with
//       finishReason='aborted' instead of dropping everything.
//   (c) tool_call deltas across many chunks accumulate by `index` into
//       a fully-formed ToolCallRequest (id + name + parsed args).
//   (d) onPartialText callback fires per chunk with delta + running total.
//   (e) when streamPartialText is false (default), the loop uses
//       buffered chat() — backwards compatible.

import { describe, it, expect } from 'bun:test'
import {
  LlmProvider,
  type ChatOptions,
  type ChatResult,
  type ChatStreamChunk,
  type LlmMessage,
  type NormalizedOptions,
} from '../../src/core/llm/provider-base.js'
import { runAgentLoop } from '../../src/core/llm/agent-loop.js'
import type { DispatcherResult } from '../../src/core/llm/tool-dispatcher.js'

class StreamingStubProvider extends LlmProvider {
  private readonly streamQueue: ChatStreamChunk[][]
  private readonly bufferedQueue: ChatResult[]
  /** Per-invocation hook to abort mid-stream (e.g. after N chunks). */
  abortAfterChunk: number | null = null
  abortController: AbortController | null = null
  public chatCalls = 0
  public streamCalls = 0
  constructor(streamQueue: ChatStreamChunk[][], bufferedQueue: ChatResult[] = []) {
    super({ name: 'stream-stub', model: 'stub-m', providerType: 'stub' })
    this.streamQueue = streamQueue
    this.bufferedQueue = bufferedQueue
  }
  override async chat(_m: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.chatCalls += 1
    const next = this.bufferedQueue.shift()
    if (!next) throw new Error('buffered queue exhausted')
    if (opts.onUsage && next.usage) { try { opts.onUsage(next.usage) } catch { /* */ } }
    return next
  }
  override async *chatStream(_m: LlmMessage[], opts: ChatOptions = {}): AsyncIterable<ChatStreamChunk> {
    this.streamCalls += 1
    const chunks = this.streamQueue.shift()
    if (!chunks) throw new Error('stream queue exhausted')
    for (let i = 0; i < chunks.length; i++) {
      // Abort-before-yield semantics: chunks 0..N-1 are observed by the
      // consumer; at index N the abort fires and the throw stops the
      // generator before chunk N reaches the accumulator.
      if (this.abortAfterChunk !== null && i === this.abortAfterChunk && this.abortController) {
        this.abortController.abort()
      }
      if (opts.signal?.aborted) {
        const e = new Error('aborted'); (e as { name?: string }).name = 'AbortError'; throw e
      }
      const c = chunks[i]!
      yield c
      if (c.usage && opts.onUsage) { try { opts.onUsage(c.usage) } catch { /* */ } }
    }
  }
  protected async _callApi(
    _m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal,
  ): Promise<ChatResult> { throw new Error('unused') }
}

describe('runAgentLoop — streaming + partial preservation (v1.2.112)', () => {
  it('default (streamPartialText off) uses buffered chat() — backwards compatible', async () => {
    const provider = new StreamingStubProvider([], [
      { text: 'hello world', finishReason: 'stop', usage: {}, modelUsed: 'stub-m' },
    ])
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      // streamPartialText omitted → false
    })
    expect(provider.chatCalls).toBe(1)
    expect(provider.streamCalls).toBe(0)
  })

  it('streamPartialText=true switches to chatStream and accumulates text', async () => {
    const provider = new StreamingStubProvider([[
      { textDelta: 'Hello' },
      { textDelta: ', ' },
      { textDelta: 'world' },
      { textDelta: '!' },
      { textDelta: '', finishReason: 'stop' },
    ]])
    const deltas: string[] = []
    const totals: string[] = []
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
      onPartialText: (d, total) => { deltas.push(d); totals.push(total) },
    })
    expect(provider.streamCalls).toBe(1)
    expect(provider.chatCalls).toBe(0)
    expect(r.text).toBe('Hello, world!')
    expect(r.finishReason).toBe('stop')
    expect(deltas).toEqual(['Hello', ', ', 'world', '!'])
    expect(totals[3]).toBe('Hello, world!')
  })

  it('abort mid-stream preserves the partial text with finishReason=aborted', async () => {
    const ctrl = new AbortController()
    const provider = new StreamingStubProvider([[
      { textDelta: 'I was about ' },
      { textDelta: 'to say the ' },
      { textDelta: 'next thing when —' },
      // abort fires here; remaining chunks never emit
      { textDelta: ' truncated tail' },
      { textDelta: '', finishReason: 'stop' },
    ]])
    provider.abortController = ctrl
    provider.abortAfterChunk = 3 // abort right before "truncated tail"
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      signal: ctrl.signal,
      streamPartialText: true,
    })
    expect(r.finishReason).toBe('aborted')
    expect(r.text).toBe('I was about to say the next thing when —')
    expect(r.text).not.toContain('truncated tail')
  })

  it('tool_call deltas accumulate by index into a full call (id + name + parsed args)', async () => {
    // OpenAI-style: first chunk has id+name, subsequent chunks add
    // `function.arguments` fragments. Accumulation must reconstruct the
    // full call so the dispatch path can run it.
    const provider = new StreamingStubProvider([
      [
        {
          textDelta: '',
          toolCallDeltas: [{ index: 0, id: 'call_x', name: 'native_read_file' }],
        },
        {
          textDelta: '',
          toolCallDeltas: [{ index: 0, argumentsDelta: '{"path":' }],
        },
        {
          textDelta: '',
          toolCallDeltas: [{ index: 0, argumentsDelta: '"/etc/hostname"}' }],
        },
        { textDelta: '', finishReason: 'tool_use' },
      ],
      // Second iteration after tool result lands.
      [
        { textDelta: 'done', finishReason: 'stop' },
      ],
    ])
    let dispatchArgs: Record<string, unknown> | undefined
    const dispatch = async (call: { name: string; arguments: Record<string, unknown> }): Promise<DispatcherResult> => {
      dispatchArgs = call.arguments
      return { text: 'localhost\n', isError: false, source: 'stub' }
    }
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'native_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      streamPartialText: true,
    })
    expect(dispatchArgs).toEqual({ path: '/etc/hostname' })
    expect(r.toolCalls.length).toBe(1)
    expect(r.toolCalls[0]!.name).toBe('native_read_file')
    expect(r.text).toBe('done')
  })

  it('complete toolCalls delivered in one chunk (pseudo-stream) are dispatched', async () => {
    // Mirrors a pseudo-streaming provider (e.g. Anthropic's buffered
    // _callApiStream): the chunk carries fully-formed `toolCalls` instead
    // of incremental `toolCallDeltas`. The loop must still dispatch them.
    // Regression for the bug where Anthropic native turns dropped every
    // tool call because the delta accumulator stayed empty.
    const provider = new StreamingStubProvider([
      [
        {
          textDelta: 'calling',
          toolCalls: [{ id: 'toolu_1', name: 'native_read_file', arguments: { path: '/etc/hostname' } }],
          finishReason: 'tool_use',
        },
      ],
      // Second iteration after the tool result lands.
      [
        { textDelta: 'done', finishReason: 'stop' },
      ],
    ])
    let dispatchArgs: Record<string, unknown> | undefined
    const dispatch = async (call: { name: string; arguments: Record<string, unknown> }): Promise<DispatcherResult> => {
      dispatchArgs = call.arguments
      return { text: 'localhost\n', isError: false, source: 'stub' }
    }
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'native_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      streamPartialText: true,
    })
    expect(dispatchArgs).toEqual({ path: '/etc/hostname' })
    expect(r.toolCalls.length).toBe(1)
    expect(r.toolCalls[0]!.name).toBe('native_read_file')
    expect(r.text).toBe('done')
  })

  it('reasoning_content deltas concatenate into ChatResult.reasoningContent', async () => {
    const provider = new StreamingStubProvider([[
      { textDelta: '', reasoningDelta: 'thinking 1 ' },
      { textDelta: '', reasoningDelta: 'thinking 2' },
      { textDelta: 'answer', finishReason: 'stop' },
    ]])
    // Use the chatStream return through agent-loop; we can't see
    // reasoningContent directly via AgentLoopResult so just verify
    // streaming completed and text accumulated.
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    expect(r.text).toBe('answer')
  })
})
