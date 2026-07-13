// v1.2.109 — integration coverage for parallel tool-call batching in
// runAgentLoop. The detector-level helpers (stableStringify, isStuckLoop,
// etc.) are covered by stuck-loop.test.ts; this file pins the actual
// scheduling: declared-safe calls run concurrently, undeclared calls
// keep the serial barrier, original order is preserved in history.
//
// Uses a stub LlmProvider that returns a pre-queued sequence of
// ChatResults so the loop sees deterministic tool_calls each iteration.

import { describe, it, expect } from 'bun:test'
import {
  LlmProvider,
  type ChatOptions,
  type ChatResult,
  type LlmMessage,
  type NormalizedOptions,
  type ToolCallRequest,
} from '../../src/core/llm/provider-base.js'
import { runAgentLoop } from '../../src/core/llm/agent-loop.js'
import type { DispatcherResult } from '../../src/core/llm/tool-dispatcher.js'

// ─── stub provider ────────────────────────────────────────────────────

class QueuedStubProvider extends LlmProvider {
  private readonly queue: ChatResult[]
  constructor(queue: ChatResult[]) {
    super({ name: 'stub', model: 'stub-m', providerType: 'stub' })
    this.queue = queue
  }
  override async chat(_messages: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const next = this.queue.shift()
    if (!next) throw new Error('stub provider: queue exhausted')
    if (opts.onUsage && next.usage) { try { opts.onUsage(next.usage) } catch { /* */ } }
    return next
  }
  protected async _callApi(
    _messages: LlmMessage[], _opts: NormalizedOptions, _signal: AbortSignal,
  ): Promise<ChatResult> {
    throw new Error('not used')
  }
}

function tc(id: string, name: string, args: Record<string, unknown>): ToolCallRequest {
  return { id, name, arguments: args }
}

function turn(toolCalls: ToolCallRequest[]): ChatResult {
  return {
    text: '',
    toolCalls,
    finishReason: 'tool_use',
    usage: {},
    modelUsed: 'stub-m',
  }
}

function done(text = 'ok'): ChatResult {
  return {
    text,
    finishReason: 'stop',
    usage: {},
    modelUsed: 'stub-m',
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── tests ────────────────────────────────────────────────────────────

describe('runAgentLoop — parallel tool-call batching (v1.2.109)', () => {
  it('declared-safe calls in one iteration run concurrently (~max, not sum)', async () => {
    const calls = [tc('1', 'agim_read_file', { path: 'a' }),
                   tc('2', 'agim_read_file', { path: 'b' }),
                   tc('3', 'agim_read_file', { path: 'c' })]
    const provider = new QueuedStubProvider([turn(calls), done()])
    const each = 80  // ms per tool
    const dispatch = async (_call: ToolCallRequest): Promise<DispatcherResult> => {
      await sleep(each)
      return { text: 'ok', isError: false, source: 'stub' }
    }

    const t0 = Date.now()
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'agim_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      parallelSafeTools: new Set(['agim_read_file']),
    })
    const elapsed = Date.now() - t0

    expect(r.toolCalls.length).toBe(3)
    expect(r.finishReason).toBe('stop')
    // With 80ms per call and full parallelism, all 3 finish in ~80ms.
    // Serial would take ≥240ms. Give a generous lower bound for noise.
    expect(elapsed).toBeLessThan(each * 3 - 30) // i.e. < 210ms
    expect(elapsed).toBeGreaterThan(each - 20)  // i.e. > 60ms (sanity)
  }, 5000)

  it('without parallelSafeTools the loop stays fully serial (backward-compat)', async () => {
    const calls = [tc('1', 'agim_read_file', { path: 'a' }),
                   tc('2', 'agim_read_file', { path: 'b' }),
                   tc('3', 'agim_read_file', { path: 'c' })]
    const provider = new QueuedStubProvider([turn(calls), done()])
    const each = 60
    const dispatch = async (): Promise<DispatcherResult> => {
      await sleep(each)
      return { text: 'ok', isError: false, source: 'stub' }
    }

    const t0 = Date.now()
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'agim_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      // parallelSafeTools omitted → all serial
    })
    const elapsed = Date.now() - t0

    // Sum at minimum; allow noise.
    expect(elapsed).toBeGreaterThan(each * 3 - 30)
  }, 5000)

  it('preserves original call order in history + reports regardless of completion order', async () => {
    const calls = [tc('1', 'agim_read_file', { path: 'slow' }),
                   tc('2', 'agim_read_file', { path: 'fast' }),
                   tc('3', 'agim_read_file', { path: 'mid' })]
    const provider = new QueuedStubProvider([turn(calls), done()])
    // call 1 takes longest, 2 fastest, 3 middle → completion order: 2, 3, 1
    const latency: Record<string, number> = { slow: 120, fast: 20, mid: 60 }
    const dispatch = async (call: ToolCallRequest): Promise<DispatcherResult> => {
      const path = String((call.arguments as { path?: string }).path ?? '')
      await sleep(latency[path] ?? 30)
      return { text: `read:${path}`, isError: false, source: 'stub' }
    }

    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'agim_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      parallelSafeTools: new Set(['agim_read_file']),
    })

    // reports preserve original order (slow, fast, mid)
    expect(r.toolCalls.map((c) => c.preview)).toEqual(['read:slow', 'read:fast', 'read:mid'])
    // argsKey reflects original args
    expect(r.toolCalls[0]!.argsKey).toContain('slow')
    expect(r.toolCalls[1]!.argsKey).toContain('fast')
    expect(r.toolCalls[2]!.argsKey).toContain('mid')
  }, 5000)

  it('parallelSafeClassifier classifies per-call (takes precedence) and is fail-closed on throw', async () => {
    // Same tool NAME, different inputs → the classifier decides per call:
    // 'read' is concurrent-safe, 'boom' makes the classifier throw → that
    // call must run serially (fail-closed) without crashing the turn.
    const calls = [
      tc('1', 'poly', { mode: 'read' }),
      tc('2', 'poly', { mode: 'read' }),
      tc('3', 'poly', { mode: 'boom' }),
    ]
    const provider = new QueuedStubProvider([turn(calls), done()])
    const dispatch = async (): Promise<DispatcherResult> => {
      await sleep(30)
      return { text: 'ok', isError: false, source: 'stub' }
    }
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'poly', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      // The static set would classify 'poly' as unsafe everywhere; the
      // classifier takes precedence and decides per-call.
      parallelSafeTools: new Set(),
      parallelSafeClassifier: (call) => {
        const mode = (call.arguments as { mode?: string }).mode
        if (mode === 'boom') throw new Error('classifier blew up')
        return mode === 'read'
      },
    })
    // All three dispatched, the throwing classifier did NOT crash the turn.
    expect(r.toolCalls.length).toBe(3)
    expect(r.finishReason).toBe('stop')
  }, 5000)

  it('serial barrier: a non-parallel-safe call drains pending parallel before dispatching', async () => {
    // Sequence: 2 parallel-safe + 1 serial + 2 parallel-safe.
    // We expect the SERIAL call to start AFTER both leading parallels
    // have finished (drain), and the trailing parallels to start AFTER
    // the serial completes.
    const calls = [
      tc('1', 'agim_read_file', { path: 'p1' }),
      tc('2', 'agim_read_file', { path: 'p2' }),
      tc('3', 'agim_write_file', { path: 'serial' }), // not in parallel set
      tc('4', 'agim_read_file', { path: 'p3' }),
      tc('5', 'agim_read_file', { path: 'p4' }),
    ]
    const provider = new QueuedStubProvider([turn(calls), done()])
    const events: Array<{ id: string; phase: 'start' | 'end'; t: number }> = []
    const start = Date.now()
    const dispatch = async (call: ToolCallRequest): Promise<DispatcherResult> => {
      events.push({ id: call.id, phase: 'start', t: Date.now() - start })
      await sleep(60)
      events.push({ id: call.id, phase: 'end', t: Date.now() - start })
      return { text: 'ok', isError: false, source: 'stub' }
    }
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        { name: 'agim_read_file', description: '', parameters: { type: 'object', properties: {} } },
        { name: 'agim_write_file', description: '', parameters: { type: 'object', properties: {} } },
      ],
      dispatch,
      parallelSafeTools: new Set(['agim_read_file']),
    })
    const startOf = (id: string) => events.find((e) => e.id === id && e.phase === 'start')!.t
    const endOf = (id: string) => events.find((e) => e.id === id && e.phase === 'end')!.t
    // The serial call (3) must start after BOTH leading parallels (1, 2) ended.
    expect(startOf('3')).toBeGreaterThanOrEqual(endOf('1') - 10)
    expect(startOf('3')).toBeGreaterThanOrEqual(endOf('2') - 10)
    // The trailing parallels (4, 5) must start after the serial ended.
    expect(startOf('4')).toBeGreaterThanOrEqual(endOf('3') - 10)
    expect(startOf('5')).toBeGreaterThanOrEqual(endOf('3') - 10)
    // And (4, 5) themselves should overlap (start close together).
    expect(Math.abs(startOf('4') - startOf('5'))).toBeLessThan(20)
  }, 5000)
})
