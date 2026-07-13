// v1.2.111 — locks the per-tool-call audit + trace-id propagation:
//   (a) every dispatched tool call publishes one audit event with
//       intent='tool.<name>' and the parent traceId.
//   (b) dispatchers receive a `toolCtx` carrying the parent traceId so
//       fan-out paths (agim-dispatcher → A2A) can chain instead of
//       minting a fresh root.
//
// Why event-bus and not SQLite: the audit DB uses better-sqlite3, which
// doesn't load under bun's test runtime — sqlite-helper transitions to
// "broken" and writes become no-ops. logInvocation always publishes to
// the event-bus first (in-memory, runtime-agnostic), so the bus is the
// stable observation point.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  LlmProvider,
  type ChatOptions,
  type ChatResult,
  type LlmMessage,
  type NormalizedOptions,
  type ToolCallRequest,
} from '../../src/core/llm/provider-base.js'
import { runAgentLoop } from '../../src/core/llm/agent-loop.js'
import type { DispatcherResult, ToolDispatcherContext } from '../../src/core/llm/tool-dispatcher.js'
import { eventBus, type AgimEvent, type AuditEvent } from '../../src/core/event-bus.js'

class QueuedStub extends LlmProvider {
  private readonly q: ChatResult[]
  constructor(q: ChatResult[]) {
    super({ name: 'stub-audit', model: 'stub-m', providerType: 'stub' })
    this.q = q
  }
  override async chat(_m: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const n = this.q.shift()
    if (!n) throw new Error('queue exhausted')
    if (opts.onUsage && n.usage) { try { opts.onUsage(n.usage) } catch { /* */ } }
    return n
  }
  protected async _callApi(
    _m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal,
  ): Promise<ChatResult> { throw new Error('unused') }
}

const tc = (id: string, name: string, args: Record<string, unknown>): ToolCallRequest =>
  ({ id, name, arguments: args })
const turn = (toolCalls: ToolCallRequest[]): ChatResult => ({
  text: '', toolCalls, finishReason: 'tool_use', usage: {}, modelUsed: 'stub-m',
})
const done = (text = 'ok'): ChatResult => ({
  text, finishReason: 'stop', usage: {}, modelUsed: 'stub-m',
})

describe('runAgentLoop — per-tool audit + traceId propagation (v1.2.111)', () => {
  let captured: AuditEvent[] = []
  const onEvent = (e: AgimEvent) => {
    if (e.type === 'audit') captured.push(e)
  }
  beforeEach(() => {
    captured = []
    eventBus.on('event', onEvent)
  })
  afterEach(() => {
    eventBus.off('event', onEvent)
  })

  it('publishes one audit event per tool call with intent=tool.<name> + parent traceId', async () => {
    const traceId = `audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const provider = new QueuedStub([
      turn([tc('1', 'agim_now', {}), tc('2', 'agim_echo', { text: 'hi' })]),
      done(),
    ])
    const dispatch = async (call: ToolCallRequest): Promise<DispatcherResult> => ({
      text: `ran:${call.name}`, isError: false, source: 'stub',
    })
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        { name: 'agim_now', description: '', parameters: { type: 'object', properties: {} } },
        { name: 'agim_echo', description: '', parameters: { type: 'object', properties: {} } },
      ],
      dispatch,
      audit: { agent: 'native-test', userId: 'u1', platform: 'unit-test', traceId },
    })
    const mine = captured.filter((e) => e.traceId === traceId)
    const toolEvents = mine.filter((e) => e.intent.startsWith('tool.'))
    const intents = toolEvents.map((e) => e.intent).sort()
    expect(intents).toEqual(['tool.agim_echo', 'tool.agim_now'])
    for (const e of toolEvents) {
      expect(e.agent).toBe('native-test')
      expect(e.platform).toBe('unit-test')
      expect(e.userId).toBe('u1')
      expect(e.success).toBe(true)
    }
  })

  it('tool error → audit event marks success=false', async () => {
    const traceId = `audit-err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const provider = new QueuedStub([
      turn([tc('1', 'agim_read_file', { path: '/x' })]),
      done(),
    ])
    const dispatch = async (): Promise<DispatcherResult> => ({
      text: 'ENOENT: no such file or directory',
      isError: true,
      source: 'native-fs',
    })
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'agim_read_file', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      audit: { agent: 'native-test', userId: 'u2', platform: 'unit-test', traceId },
    })
    const toolEv = captured.find((e) => e.traceId === traceId && e.intent === 'tool.agim_read_file')
    expect(toolEv).toBeDefined()
    expect(toolEv!.success).toBe(false)
  })

  it('dispatcher receives toolCtx with parent traceId (A2A chaining hook)', async () => {
    const traceId = `tracectx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const provider = new QueuedStub([
      turn([tc('a', 'mcp__agim__call_agent', { agent: 'codex', prompt: 'hi' })]),
      done(),
    ])
    let observedCtx: ToolDispatcherContext | undefined
    const dispatch = async (
      _c: ToolCallRequest, _s: AbortSignal, ctx?: ToolDispatcherContext,
    ): Promise<DispatcherResult> => {
      observedCtx = ctx
      return { text: 'ok', isError: false, source: 'stub' }
    }
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'mcp__agim__call_agent', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      audit: { agent: 'native-test', userId: 'u3', platform: 'unit-test', traceId },
    })
    expect(observedCtx).toBeDefined()
    expect(observedCtx!.traceId).toBe(traceId)
  })

  it('no audit ctx → no tool audit events published (no crash)', async () => {
    const provider = new QueuedStub([turn([tc('1', 'agim_now', {})]), done()])
    const dispatch = async (): Promise<DispatcherResult> => ({ text: 'ok', isError: false })
    const before = captured.length
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'agim_now', description: '', parameters: { type: 'object', properties: {} } }],
      dispatch,
      // No `audit` field — writeToolCallAudit short-circuits.
    })
    expect(r.toolCalls.length).toBe(1)
    expect(r.finishReason).toBe('stop')
    // Nothing under any tool intent landed for this test.
    const added = captured.slice(before).filter((e) => e.intent.startsWith('tool.'))
    expect(added.length).toBe(0)
  })
})
