// Unit tests for agent-loop.
//
// We don't go through a real provider/network here — the loop's
// correctness is about iteration accounting, dispatch routing, history
// shape, and abort/timeout/approval edge cases. Each test wires a
// FakeProvider that returns scripted ChatResult sequences and a stub
// dispatcher / approval gate, then asserts on the AgentLoopResult and
// the messages the loop fed back to the provider on each turn.

import { describe, it, expect } from 'bun:test'
import { runAgentLoop, alwaysAllowGate, type ApprovalGate } from './agent-loop.js'
import {
  LlmProvider,
  type ChatResult,
  type LlmMessage,
  type LlmUsage,
  type NormalizedOptions,
  type ToolCallRequest,
} from './provider-base.js'
import type { ToolDispatcher } from './tool-dispatcher.js'

// ── Fake provider ───────────────────────────────────────────────────

class FakeProvider extends LlmProvider {
  /** Captured messages array passed to chat() on each call. */
  public seenMessages: LlmMessage[][] = []
  /** Number of times chat() was invoked. */
  public callCount = 0
  /** Optional onUsage we'll fire each call. */
  public emitUsage: LlmUsage | null = null

  constructor(private scripts: ChatResult[]) {
    super({ name: 'fake', model: 'fake-1', providerType: 'fake', apiKey: 'x' })
  }

  protected async _callApi(
    messages: LlmMessage[],
    _opts: NormalizedOptions,
    _signal: AbortSignal,
  ): Promise<ChatResult> {
    // Snapshot the messages so the test can inspect history shape per turn.
    this.seenMessages.push(messages.map((m) => ({ ...m })))
    const i = this.callCount++
    const r = this.scripts[i]
    if (!r) {
      throw new Error(`FakeProvider: no script for call #${i}`)
    }
    return r
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCallRequest {
  return { id, name, arguments: args }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('runAgentLoop — basics', () => {
  it('zero-tool single iteration: returns provider text + finishReason=stop', async () => {
    const p = new FakeProvider([
      { text: 'hi there', finishReason: 'stop', usage: { totalTokens: 5 }, modelUsed: 'fake-1' },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(r.text).toBe('hi there')
    expect(r.finishReason).toBe('stop')
    expect(r.iterations).toBe(1)
    expect(r.toolCalls).toHaveLength(0)
    expect(r.usage.totalTokens).toBe(5)
  })

  it('throws when tools is set but dispatch is missing', async () => {
    const p = new FakeProvider([])
    await expect(runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'do', description: '', parameters: {} }],
    })).rejects.toThrow(/dispatch is required/i)
  })

  it('caller messages are not mutated', async () => {
    const p = new FakeProvider([
      { text: 'ok', finishReason: 'stop', usage: {}, modelUsed: 'fake-1' },
    ])
    const original: LlmMessage[] = [{ role: 'user', content: 'x' }]
    await runAgentLoop({ provider: p, messages: original })
    expect(original).toHaveLength(1)
    expect(original[0]).toEqual({ role: 'user', content: 'x' })
  })
})

describe('runAgentLoop — multi-iteration tool dispatch', () => {
  it('dispatches a tool call, appends tool result, continues, then returns final text', async () => {
    const calls: string[] = []
    const dispatch: ToolDispatcher = async (call) => {
      calls.push(`${call.name}:${JSON.stringify(call.arguments)}`)
      return { text: `result:${call.arguments.x}`, isError: false, source: 'mcp:fake' }
    }
    const p = new FakeProvider([
      {
        text: 'calling tool',
        toolCalls: [toolCall('c1', 'mcp_fake_do', { x: 42 })],
        finishReason: 'tool_use',
        usage: { totalTokens: 5 },
        modelUsed: 'fake-1',
      },
      {
        text: 'all done',
        finishReason: 'stop',
        usage: { totalTokens: 7 },
        modelUsed: 'fake-1',
      },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [{ name: 'mcp_fake_do', description: '', parameters: {} }],
      dispatch,
    })
    expect(r.text).toBe('all done')
    expect(r.iterations).toBe(2)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0].name).toBe('mcp_fake_do')
    expect(r.toolCalls[0].decision).toBe('allow')
    expect(r.toolCalls[0].isError).toBe(false)
    expect(r.toolCalls[0].source).toBe('mcp:fake')
    expect(calls).toEqual(['mcp_fake_do:{"x":42}'])
    expect(r.usage.totalTokens).toBe(12)  // 5 + 7

    // Second iteration's messages should include the assistant tool_use
    // turn and the tool result message.
    const turn2 = p.seenMessages[1]
    expect(turn2[1].role).toBe('assistant')
    expect(turn2[1].toolCalls?.[0].id).toBe('c1')
    expect(turn2[2].role).toBe('tool')
    expect(turn2[2].toolCallId).toBe('c1')
    expect(turn2[2].content).toBe('result:42')
  })

  it('handles multiple tool calls in one assistant turn', async () => {
    const dispatch: ToolDispatcher = async (call) => ({
      text: `${call.name}-ok`, isError: false, source: 'mcp:x',
    })
    const p = new FakeProvider([
      {
        text: 'fanning out',
        toolCalls: [
          toolCall('c1', 'mcp_x_a', {}),
          toolCall('c2', 'mcp_x_b', {}),
        ],
        finishReason: 'tool_use',
        usage: {},
        modelUsed: 'fake-1',
      },
      {
        text: 'aggregated',
        finishReason: 'stop',
        usage: {},
        modelUsed: 'fake-1',
      },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'fan out' }],
      tools: [
        { name: 'mcp_x_a', description: '', parameters: {} },
        { name: 'mcp_x_b', description: '', parameters: {} },
      ],
      dispatch,
    })
    expect(r.toolCalls.map((t) => t.name)).toEqual(['mcp_x_a', 'mcp_x_b'])
    // Both tool results appear in iteration #2's history.
    const turn2 = p.seenMessages[1]
    const toolMsgs = turn2.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['c1', 'c2'])
  })

  it('dispatcher errors are surfaced as tool result, loop continues', async () => {
    const dispatch: ToolDispatcher = async () => ({
      text: 'permission denied', isError: true, source: 'mcp:fs',
    })
    const p = new FakeProvider([
      {
        text: '',
        toolCalls: [toolCall('c1', 'mcp_fs_read', { path: '/etc/shadow' })],
        finishReason: 'tool_use',
        usage: {},
        modelUsed: 'fake-1',
      },
      {
        text: 'sorry, cannot read that',
        finishReason: 'stop',
        usage: {},
        modelUsed: 'fake-1',
      },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'read shadow' }],
      tools: [{ name: 'mcp_fs_read', description: '', parameters: {} }],
      dispatch,
    })
    expect(r.toolCalls[0].isError).toBe(true)
    expect(r.text).toBe('sorry, cannot read that')
    expect(r.finishReason).toBe('stop')
  })

  it('dispatcher throws → caught + surfaced as error tool result', async () => {
    const dispatch: ToolDispatcher = async () => {
      throw new Error('boom')
    }
    const p = new FakeProvider([
      {
        text: '',
        toolCalls: [toolCall('c1', 'mcp_x_y', {})],
        finishReason: 'tool_use',
        usage: {},
        modelUsed: 'fake-1',
      },
      { text: 'noted', finishReason: 'stop', usage: {}, modelUsed: 'fake-1' },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'mcp_x_y', description: '', parameters: {} }],
      dispatch,
    })
    expect(r.toolCalls[0].isError).toBe(true)
    expect(r.toolCalls[0].preview).toContain('boom')
    expect(r.finishReason).toBe('stop')
  })
})

describe('runAgentLoop — approval gate', () => {
  it('deny: tool not dispatched, "denied by user" tool result fed back', async () => {
    let dispatched = false
    const dispatch: ToolDispatcher = async () => {
      dispatched = true
      return { text: 'should not run', isError: false, source: 'mcp:x' }
    }
    const denyGate: ApprovalGate = async () => 'deny'
    const p = new FakeProvider([
      {
        text: '',
        toolCalls: [toolCall('c1', 'mcp_x_run', {})],
        finishReason: 'tool_use',
        usage: {},
        modelUsed: 'fake-1',
      },
      { text: 'ok, skipping', finishReason: 'stop', usage: {}, modelUsed: 'fake-1' },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'mcp_x_run', description: '', parameters: {} }],
      dispatch,
      approve: denyGate,
    })
    expect(dispatched).toBe(false)
    expect(r.toolCalls[0].decision).toBe('deny')
    expect(r.toolCalls[0].isError).toBe(true)
    const turn2 = p.seenMessages[1]
    const toolMsg = turn2.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('denied by user')
  })

  it('gate throws → treated as deny (fail-closed)', async () => {
    const explodeGate: ApprovalGate = async () => {
      throw new Error('gate broken')
    }
    const p = new FakeProvider([
      {
        text: '',
        toolCalls: [toolCall('c1', 'mcp_x_run', {})],
        finishReason: 'tool_use',
        usage: {},
        modelUsed: 'fake-1',
      },
      { text: 'ok', finishReason: 'stop', usage: {}, modelUsed: 'fake-1' },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'mcp_x_run', description: '', parameters: {} }],
      dispatch: async () => ({ text: 'x', isError: false, source: 'mcp:x' }),
      approve: explodeGate,
    })
    expect(r.toolCalls[0].decision).toBe('deny')
  })

  it('alwaysAllowGate is the default', async () => {
    let dispatched = false
    const p = new FakeProvider([
      {
        text: '',
        toolCalls: [toolCall('c1', 'mcp_x_run', {})],
        finishReason: 'tool_use',
        usage: {},
        modelUsed: 'fake-1',
      },
      { text: 'done', finishReason: 'stop', usage: {}, modelUsed: 'fake-1' },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'mcp_x_run', description: '', parameters: {} }],
      dispatch: async () => { dispatched = true; return { text: 'ok', isError: false, source: 'mcp:x' } },
      // approve omitted -> alwaysAllowGate
    })
    expect(dispatched).toBe(true)
    expect(r.toolCalls[0].decision).toBe('allow')
  })

  it('exported alwaysAllowGate is allow', async () => {
    const r = await alwaysAllowGate(toolCall('c', 'n', {}), 0)
    expect(r).toBe('allow')
  })
})

describe('runAgentLoop — limits & abort', () => {
  it('hits maxIterations when model keeps requesting tools', async () => {
    // Scripts: provider always returns a tool call; loop should abort
    // at maxIterations=3.
    const scripts: ChatResult[] = []
    for (let i = 0; i < 10; i++) {
      scripts.push({
        text: `loop ${i}`,
        toolCalls: [toolCall(`c${i}`, 'mcp_x_run', {})],
        finishReason: 'tool_use',
        usage: {},
        modelUsed: 'fake-1',
      })
    }
    const p = new FakeProvider(scripts)
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'loop' }],
      tools: [{ name: 'mcp_x_run', description: '', parameters: {} }],
      dispatch: async () => ({ text: 'ran', isError: false, source: 'mcp:x' }),
      maxIterations: 3,
    })
    expect(r.iterations).toBe(3)
    expect(r.toolCalls).toHaveLength(3)
    expect(r.finishReason).toBe('max_iterations')
    expect(r.text).toBe('')  // never reached a non-tool finish
  })

  it('respects outer AbortSignal before first iteration', async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error('cancel'))
    const p = new FakeProvider([])  // never reached
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'x' }],
      signal: ctrl.signal,
    })
    expect(r.finishReason).toBe('aborted')
    expect(r.iterations).toBe(0)
    expect(p.callCount).toBe(0)
  })

  it('provider throws → finishReason=error, text="", error preserved', async () => {
    const p = new FakeProvider([])  // empty scripts → throws on first call
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(r.finishReason).toBe('error')
    expect(r.text).toBe('')
    expect(r.error).toContain('no script')
    expect(r.iterations).toBe(1)
  })
})

describe('runAgentLoop — usage accounting', () => {
  it('aggregates totalTokens / promptTokens / completionTokens / costUsd across iterations', async () => {
    const p = new FakeProvider([
      {
        text: '',
        toolCalls: [toolCall('c1', 'mcp_x_y', {})],
        finishReason: 'tool_use',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, costUsd: 0.01 },
        modelUsed: 'fake-1',
      },
      {
        text: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9, costUsd: 0.03 },
        modelUsed: 'fake-1',
      },
    ])
    const r = await runAgentLoop({
      provider: p,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'mcp_x_y', description: '', parameters: {} }],
      dispatch: async () => ({ text: '', isError: false, source: 'mcp:x' }),
    })
    expect(r.usage.promptTokens).toBe(5)
    expect(r.usage.completionTokens).toBe(7)
    expect(r.usage.totalTokens).toBe(12)
    expect(r.usage.costUsd).toBeCloseTo(0.04, 6)
  })
})
