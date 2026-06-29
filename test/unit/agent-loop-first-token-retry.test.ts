// v1.2.138 — first-token retry on transient stream errors.
//
// Pins:
//   (a) transient error before first token + partial=0 → auto-retry,
//       2nd call succeeds, result returned as if first call worked
//   (b) non-transient errors (e.g. "AUTH_INVALID") → no retry, throws
//       immediately
//   (c) abort errors → no retry (already handled elsewhere)
//   (d) env AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX=0 disables retry
//   (e) all retries exhausted → final error surfaces
//
// We can't easily test the delay path without flaky time-based
// assertions, so retry delay is forced to 0 via env.

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

class FlakyStreamProvider extends LlmProvider {
  /** Array of "throw on attempt N" indicators. true = throw transient,
   *  false = succeed with a normal short stream, string = throw with
   *  custom error message. */
  public attempts: Array<true | false | string> = []
  public streamCalls = 0
  constructor(public script: Array<true | false | string>) {
    super({ name: 'flaky', model: 'stub', providerType: 'stub' })
    this.attempts = [...script]
  }
  override async *chatStream(_m: LlmMessage[], _opts: ChatOptions = {}): AsyncIterable<ChatStreamChunk> {
    this.streamCalls += 1
    const next = this.attempts.shift()
    if (next === true) {
      const err = new Error('terminated')
      ;(err as { cause?: Error }).cause = new Error('socket hang up')
      throw err
    }
    if (typeof next === 'string') {
      throw new Error(next)
    }
    yield { textDelta: 'hi ', finishReason: undefined }
    yield { textDelta: 'there', finishReason: 'stop' }
  }
  override async chat(_m: LlmMessage[], _o: ChatOptions = {}): Promise<ChatResult> {
    throw new Error('unused — stream path under test')
  }
  protected async _callApi(
    _m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal,
  ): Promise<ChatResult> { throw new Error('unused') }
}

describe('runAgentLoop — first-token retry (v1.2.138)', () => {
  const KEYS = [
    'AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX',
    'AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS',
  ]
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    // Always force 0ms delay so tests don't waste 1s per case.
    process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS = '0'
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('transient "terminated" then success → returns the second stream', async () => {
    // Default retry max = 1.
    const provider = new FlakyStreamProvider([true, false])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    expect(provider.streamCalls).toBe(2)
    expect(r.text).toBe('hi there')
    expect(r.finishReason).toBe('stop')
  })

  it('non-transient error (auth-style) → no retry, surfaces immediately', async () => {
    const provider = new FlakyStreamProvider(['AUTH_INVALID: bad token'])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    // Should NOT retry — the loop's outer catch surfaces as finishReason: 'error'.
    expect(provider.streamCalls).toBe(1)
    expect(r.finishReason).toBe('error')
    expect(r.error).toMatch(/AUTH_INVALID/)
  })

  it('AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX=0 disables retry', async () => {
    process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX = '0'
    const provider = new FlakyStreamProvider([true, false])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    expect(provider.streamCalls).toBe(1)
    expect(r.finishReason).toBe('error')
  })

  it('AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX=2 retries twice before giving up', async () => {
    process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX = '2'
    // All three throw transient → exhausted budget.
    const provider = new FlakyStreamProvider([true, true, true])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    // initial + 2 retries = 3.
    expect(provider.streamCalls).toBe(3)
    expect(r.finishReason).toBe('error')
  })

  it('AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX=2: succeeds on 2nd retry', async () => {
    process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX = '2'
    const provider = new FlakyStreamProvider([true, true, false])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      streamPartialText: true,
    })
    expect(provider.streamCalls).toBe(3)
    expect(r.text).toBe('hi there')
    expect(r.finishReason).toBe('stop')
  })

  it('matches common transient patterns: ECONNRESET, fetch failed, socket hang up', async () => {
    for (const pattern of ['ECONNRESET: read', 'fetch failed', 'socket hang up']) {
      const provider = new FlakyStreamProvider([pattern, false])
      const r = await runAgentLoop({
        provider,
        messages: [{ role: 'user', content: 'go' }],
        streamPartialText: true,
      })
      expect(provider.streamCalls).toBe(2)
      expect(r.text).toBe('hi there')
    }
  })
})
