// v1.2.123 — TCP-drop graceful degradation in streamThenBuffer.
//
// Contract:
//   (a) Mid-stream non-abort throw + partial text accumulated → return
//       with finishReason='length' (so length-recovery continues).
//   (b) Mid-stream non-abort throw + zero partial content → re-throw.
//   (c) AbortError → still treated as aborted (unchanged from v1.2.112).
//   (d) After (a) fires, length-recovery picks up: next chat() turn
//       gets the partial assistant + a "continue" nudge.

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

class InterruptingStubProvider extends LlmProvider {
  /** Pre-throw chunks; the stream emits these in order then throws.
   *  Each call to chatStream uses the next item in this array of arrays. */
  private readonly preThrowChunks: ChatStreamChunk[][]
  /** Per-call: how many chunks to emit before throwing the assigned error.
   *  -1 means "no throw, emit all chunks normally". */
  private readonly throwAfter: Array<number>
  private readonly errorToThrow: Array<Error>
  /** Fallback ChatResults for the buffered chat() path (length-recovery
   *  follow-ups). */
  private readonly bufferedQueue: ChatResult[]
  public streamCalls = 0
  public chatCalls = 0
  constructor(
    preThrowChunks: ChatStreamChunk[][],
    throwAfter: number[],
    errors: Error[],
    bufferedQueue: ChatResult[] = [],
  ) {
    super({ name: 'tcp-drop-stub', model: 'stub-m', providerType: 'stub' })
    this.preThrowChunks = preThrowChunks
    this.throwAfter = throwAfter
    this.errorToThrow = errors
    this.bufferedQueue = bufferedQueue
  }
  override async chat(_m: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.chatCalls += 1
    const next = this.bufferedQueue.shift()
    if (!next) throw new Error('buffered queue exhausted')
    if (opts.onUsage && next.usage) { try { opts.onUsage(next.usage) } catch { /* */ } }
    return next
  }
  override async *chatStream(_m: LlmMessage[], _opts: ChatOptions = {}): AsyncIterable<ChatStreamChunk> {
    const idx = this.streamCalls
    this.streamCalls += 1
    const chunks = this.preThrowChunks[idx] ?? []
    const throwAt = this.throwAfter[idx] ?? -1
    const err = this.errorToThrow[idx]
    for (let i = 0; i < chunks.length; i++) {
      if (throwAt >= 0 && i === throwAt) {
        // simulate TCP drop / ECONNRESET partway through
        throw err ?? new Error(`simulated mid-stream throw at chunk ${i}`)
      }
      yield chunks[i]!
    }
    // If throwAt is beyond chunks.length OR equal to chunks.length but
    // never reached, throw at end (simulates "stream closed early
    // without [DONE]").
    if (throwAt >= chunks.length && err) {
      throw err
    }
  }
  protected async _callApi(
    _m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal,
  ): Promise<ChatResult> { throw new Error('unused') }
}

describe('runAgentLoop — mid-stream interrupt (v1.2.123)', () => {
  // v1.2.138 introduced first-token retry (default 1 retry on transient
  // errors like ECONNRESET). These tests were written against the
  // baseline behaviour where transient errors propagate immediately.
  // Pinning retry-max=0 keeps the contracts they originally tested;
  // the retry path gets its own coverage in agent-loop-first-token-retry.test.ts.
  const savedRetryMax = process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX
  const savedRetryDelay = process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS
  beforeEach(() => {
    process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX = '0'
    process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS = '0'
  })
  afterEach(() => {
    if (savedRetryMax === undefined) delete process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX
    else process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX = savedRetryMax
    if (savedRetryDelay === undefined) delete process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS
    else process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS = savedRetryDelay
  })

  it('TCP drop with partial text → surfaced as length, then length-recovery continues', async () => {
    // Stream emits 3 text chunks then throws ECONNRESET. Length-recovery
    // then asks the model to continue; next iter's `chat()` finishes
    // the message.
    const econn = new Error('socket hang up')
    ;(econn as { code?: string }).code = 'ECONNRESET'
    const provider = new InterruptingStubProvider(
      [
        [{ textDelta: 'partial ' }, { textDelta: 'before ' }, { textDelta: 'drop' }],
      ],
      [3], // throw AT chunk index 3 (after emitting all 3)
      [econn],
      [
        // length-recovery continues with chat() (loop uses chat() on
        // the next iter since streamPartialText doesn't auto-resume).
        // Wait — length-recovery in the loop continues via chatStream
        // because streamEnabled stays true. Provide a 2nd stream batch.
      ],
    )
    // Add a 2nd successful stream batch for the recovery iter:
    ;(provider as unknown as { preThrowChunks: ChatStreamChunk[][] }).preThrowChunks.push([
      { textDelta: ' continuation', finishReason: 'stop' },
    ])
    ;(provider as unknown as { throwAfter: number[] }).throwAfter.push(-1)
    ;(provider as unknown as { errorToThrow: (Error | undefined)[] }).errorToThrow.push(undefined as unknown as Error)

    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    expect(provider.streamCalls).toBe(2)
    // Final text = partial + continuation
    expect(r.text).toBe('partial before drop continuation')
    expect(r.finishReason).toBe('stop')
  })

  it('TCP drop with ZERO partial text → re-throws (no recovery, surfaces error)', async () => {
    const econn = new Error('ECONNRESET: socket hang up')
    const provider = new InterruptingStubProvider(
      [[]],  // no chunks before throw
      [0],   // throw at index 0 (before any yield)
      [econn],
    )
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    expect(provider.streamCalls).toBe(1)
    expect(r.finishReason).toBe('error')
    expect(r.text).toBe('')
    expect(r.error).toMatch(/ECONNRESET|socket hang up/)
  })

  it('AbortError thrown by stub still maps to aborted (does NOT trigger length-recovery)', async () => {
    // Distinct from the v1.2.112 abort test in agent-loop-stream.test.ts:
    // there the signal is what triggers; here the underlying generator
    // itself throws an AbortError without any signal aborted. Our
    // catch must dispatch on the error TYPE, not just the signal
    // state, to avoid mis-treating abort as TCP drop.
    const abortErr = new Error('aborted')
    ;(abortErr as { name?: string }).name = 'AbortError'
    const provider = new InterruptingStubProvider(
      [[{ textDelta: 'streamed before abort' }]],
      [1],
      [abortErr],
    )
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    // AbortError path: finishReason becomes 'unknown' in
    // streamThenBuffer, and the loop sees no signal.aborted, so the
    // outer return uses ChatResult.finishReason directly. The key
    // assertion: it must NOT be 'length' (which would trigger an
    // unwanted recovery turn).
    expect(r.finishReason).not.toBe('length')
    expect(r.text).toBe('streamed before abort')
  })
})
