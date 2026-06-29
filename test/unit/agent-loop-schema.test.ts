// v1.2.110 — locks the integration of the JSON-Schema validator with
// runAgentLoop: bad args are caught BEFORE dispatch (dispatcher never
// invoked), the role:'tool' message handed back to the model contains
// a structured "what's wrong + retry" block, and AGIM_TOOL_SCHEMA_VALIDATE=off
// fully restores the v1.2.109 pass-through behaviour.

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
import type { DispatcherResult } from '../../src/core/llm/tool-dispatcher.js'

class QueuedStubProvider extends LlmProvider {
  private readonly queue: ChatResult[]
  constructor(queue: ChatResult[]) {
    super({ name: 'stub', model: 'stub-m', providerType: 'stub' })
    this.queue = queue
  }
  override async chat(_messages: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const next = this.queue.shift()
    if (!next) throw new Error('queue exhausted')
    if (opts.onUsage && next.usage) { try { opts.onUsage(next.usage) } catch { /* */ } }
    return next
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

const readFileTool = {
  name: 'native_read_file',
  description: 'read a file',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer' },
    },
  },
}

describe('runAgentLoop — schema validation (v1.2.110)', () => {
  // Make sure each test starts from a known env state.
  let prevEnv: string | undefined
  beforeEach(() => { prevEnv = process.env.AGIM_TOOL_SCHEMA_VALIDATE })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AGIM_TOOL_SCHEMA_VALIDATE
    else process.env.AGIM_TOOL_SCHEMA_VALIDATE = prevEnv
  })

  it('missing required field is caught BEFORE dispatch (dispatcher never called)', async () => {
    delete process.env.AGIM_TOOL_SCHEMA_VALIDATE
    const provider = new QueuedStubProvider([
      turn([tc('1', 'native_read_file', { limit: 5 })]),  // no `path`
      done(),
    ])
    let dispatchCalls = 0
    const dispatch = async (_call: ToolCallRequest): Promise<DispatcherResult> => {
      dispatchCalls += 1
      return { text: 'ok', isError: false, source: 'stub' }
    }
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [readFileTool],
      dispatch,
    })
    expect(dispatchCalls).toBe(0)
    expect(r.toolCalls.length).toBe(1)
    expect(r.toolCalls[0]!.isError).toBe(true)
    expect(r.toolCalls[0]!.source).toBe('schema-validation')
    expect(r.toolCalls[0]!.preview).toContain('native_read_file')
    expect(r.toolCalls[0]!.preview).toContain('required field missing')
  })

  it('error fed back as role:tool so the model sees what to fix', async () => {
    delete process.env.AGIM_TOOL_SCHEMA_VALIDATE
    let secondTurnMessages: LlmMessage[] = []
    class CapturingStub extends QueuedStubProvider {
      override async chat(messages: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
        if (this['queue'].length === 1) secondTurnMessages = messages.slice()
        return super.chat(messages, opts)
      }
    }
    const provider = new CapturingStub([
      turn([tc('1', 'native_read_file', { path: 123 })]),  // wrong type
      done(),
    ])
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [readFileTool],
      dispatch: async () => ({ text: 'ok', isError: false }),
    })
    // The second turn (where finishReason='stop' lands) should see the
    // role:'tool' message we synthesized with the validation error.
    expect(secondTurnMessages.length).toBeGreaterThan(0)
    const toolMsg = secondTurnMessages.find(
      (m) => m.role === 'tool' && (m.toolCallId === '1'),
    )
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content).toContain('expected string, got number')
    expect(toolMsg!.content).toContain('retry')
  })

  it('errorType is stable across same bad args (feeds stuck-loop detector)', async () => {
    delete process.env.AGIM_TOOL_SCHEMA_VALIDATE
    // 3 identical bad calls in a single iteration → after the batch
    // emit, stuck-loop detector should fire (same name + argsKey +
    // errorType). Loop returns finishReason='stuck_loop'.
    const provider = new QueuedStubProvider([
      turn([
        tc('1', 'native_read_file', { limit: 5 }),
        tc('2', 'native_read_file', { limit: 5 }),
        tc('3', 'native_read_file', { limit: 5 }),
      ]),
      done(),
    ])
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [readFileTool],
      dispatch: async () => ({ text: 'ok', isError: false }),
    })
    expect(r.finishReason).toBe('stuck_loop')
    expect(r.toolCalls.length).toBe(3)
    expect(r.toolCalls.every((c) => c.source === 'schema-validation')).toBe(true)
  })

  it('AGIM_TOOL_SCHEMA_VALIDATE=off bypasses validation (back to v1.2.109)', async () => {
    process.env.AGIM_TOOL_SCHEMA_VALIDATE = 'off'
    const provider = new QueuedStubProvider([
      turn([tc('1', 'native_read_file', { limit: 5 })]),  // bad args
      done(),
    ])
    let dispatchCalls = 0
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [readFileTool],
      dispatch: async () => {
        dispatchCalls += 1
        return { text: 'reached dispatcher', isError: false, source: 'stub' }
      },
    })
    expect(dispatchCalls).toBe(1)
    expect(r.toolCalls[0]!.isError).toBe(false)
    expect(r.toolCalls[0]!.preview).toContain('reached dispatcher')
  })

  it('valid args dispatch through untouched', async () => {
    delete process.env.AGIM_TOOL_SCHEMA_VALIDATE
    const provider = new QueuedStubProvider([
      turn([tc('1', 'native_read_file', { path: '/etc/hostname', limit: 100 })]),
      done(),
    ])
    let dispatchCalls = 0
    const r = await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'go' }],
      tools: [readFileTool],
      dispatch: async () => {
        dispatchCalls += 1
        return { text: 'localhost\n', isError: false, source: 'fs' }
      },
    })
    expect(dispatchCalls).toBe(1)
    expect(r.toolCalls[0]!.isError).toBe(false)
    expect(r.toolCalls[0]!.preview).toContain('localhost')
  })
})
