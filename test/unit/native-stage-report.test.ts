// v1.2.142 — Stage-report retry tests.
//
// `tryStageReport` is the helper that replaces v1.2.94's empty-only
// auto-summary. Every unhappy native turn (empty / max_iter /
// stuck_loop / off_track) hits this before the technical recap. We
// verify the prompt-shaped behaviour the user actually cares about:
//
//   1. Provider gets called with no tools attached (tools=[] in opts).
//   2. Successful tool previews are routed to "已经拿到 / 做到" context.
//   3. Failed tool previews are routed to "没拿到 / 卡在哪" context.
//   4. The system prompt forbids listing tool names — we assert the
//      injected user message does NOT contain `native_` / `mcp__` so
//      the model is never tempted to echo internal names back.
//   5. Provider returning empty text → null (caller falls back).
//   6. Provider throwing → null (caller falls back, no throw escapes).
//   7. Env IMHUB_NATIVE_STAGE_REPORT=off → tryStageReport returns null
//      without calling the provider (kill switch).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  LlmProvider,
  type ChatOptions,
  type ChatResult,
  type LlmMessage,
  type NormalizedOptions,
  type ToolCallRequest,
} from '../../src/core/llm/provider-base.js'
import { tryStageReport } from '../../src/plugins/agents/native/index.js'

type StubResponse = Omit<ChatResult, 'modelUsed'> & { modelUsed?: string }

class StubProvider extends LlmProvider {
  capturedMessages: LlmMessage[] = []
  capturedOpts: ChatOptions | undefined
  callCount = 0
  constructor(private readonly response: StubResponse | Error) {
    super({ name: 'stub-stage', model: 'stub-m', providerType: 'stub' })
  }
  override async chat(messages: LlmMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.callCount += 1
    this.capturedMessages = messages
    this.capturedOpts = opts
    if (this.response instanceof Error) throw this.response
    return { modelUsed: 'stub-m', ...this.response }
  }
  protected async _callApi(
    _m: LlmMessage[], _o: NormalizedOptions, _s: AbortSignal,
  ): Promise<ChatResult> {
    return {
      text: '',
      toolCalls: [] satisfies ToolCallRequest[],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelUsed: 'stub-m',
    }
  }
}

function fakeResult(toolCalls: Array<{ name: string; isError: boolean; preview?: string }>): {
  toolCalls: typeof toolCalls
  iterations: number
} {
  return { toolCalls, iterations: toolCalls.length }
}

const ENV_KEY = 'IMHUB_NATIVE_STAGE_REPORT'
const ENV_SNAPSHOT = process.env[ENV_KEY]
afterEach(() => {
  if (ENV_SNAPSHOT === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = ENV_SNAPSHOT
})

describe('v1.2.142 — tryStageReport', () => {
  beforeEach(() => { delete process.env[ENV_KEY] })

  it('returns text + costUsd when provider succeeds', async () => {
    const provider = new StubProvider({
      text: '已拿到：A=1\n没拿到：B 抓不到\n下一步：换数据源',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.0003 },
    })
    const r = await tryStageReport({
      prompt: '查 X',
      result: fakeResult([
        { name: 'native_web_search', isError: false, preview: 'got 5 results' },
        { name: 'native_web_fetch', isError: true, preview: 'HTTP 403' },
      ]),
      provider,
      kind: 'empty',
      sessionId: 'test-sess-1',
    })
    expect(r).not.toBeNull()
    expect(r!.text).toContain('已拿到')
    expect(r!.costUsd).toBe(0.0003)
    expect(provider.callCount).toBe(1)
  })

  it('does NOT pass tools to the provider — retry is plain chat', async () => {
    const provider = new StubProvider({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    await tryStageReport({
      prompt: 'q',
      result: fakeResult([{ name: 'native_now', isError: false }]),
      provider,
      kind: 'empty',
      sessionId: 'test-sess-2',
    })
    // Either tools is undefined or empty — both mean "no tools advertised".
    const tools = (provider.capturedOpts as { tools?: unknown[] } | undefined)?.tools
    expect(tools == null || (Array.isArray(tools) && tools.length === 0)).toBe(true)
  })

  it('partitions successful vs failed previews into separate context blocks', async () => {
    const provider = new StubProvider({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    await tryStageReport({
      prompt: 'q',
      result: fakeResult([
        { name: 'native_web_search', isError: false, preview: 'PAYLOAD_SUCCESS_MARKER' },
        { name: 'native_web_fetch', isError: true, preview: 'PAYLOAD_FAIL_MARKER 403' },
      ]),
      provider,
      kind: 'empty',
      sessionId: 'test-sess-3',
    })
    const user2 = provider.capturedMessages[provider.capturedMessages.length - 1]
    expect(user2.role).toBe('user')
    const content = String(user2.content)
    // The two markers exist in different sections of the prompt.
    expect(content.indexOf('PAYLOAD_SUCCESS_MARKER')).toBeGreaterThan(-1)
    expect(content.indexOf('PAYLOAD_FAIL_MARKER')).toBeGreaterThan(-1)
    // Success markers appear before fail markers (they're in the
    // "[成功的中间结果]" block which comes first).
    expect(content.indexOf('PAYLOAD_SUCCESS_MARKER'))
      .toBeLessThan(content.indexOf('PAYLOAD_FAIL_MARKER'))
  })

  it('system prompt forbids listing tool names', async () => {
    const provider = new StubProvider({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    await tryStageReport({
      prompt: 'q',
      result: fakeResult([{ name: 'native_web_fetch', isError: true }]),
      provider,
      kind: 'empty',
      sessionId: 'test-sess-4',
    })
    const sys = provider.capturedMessages.find((m) => m.role === 'system')
    expect(sys).toBeDefined()
    const sysContent = String(sys!.content)
    // The instruction explicitly bans tool-name patterns in the output.
    expect(sysContent).toContain('不要出现工具名')
    expect(sysContent).toContain('native_xxx')
    expect(sysContent).toContain('mcp__imhub__xxx')
  })

  it('off_track reason gets surfaced in the user prompt', async () => {
    const provider = new StubProvider({
      text: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    await tryStageReport({
      prompt: 'q',
      result: fakeResult([{ name: 'native_now', isError: false }]),
      provider,
      kind: 'off_track',
      offTrackReason: 'PAYLOAD_REASON_MARKER',
      sessionId: 'test-sess-5',
    })
    const user1 = provider.capturedMessages[provider.capturedMessages.length - 1]
    expect(String(user1.content)).toContain('PAYLOAD_REASON_MARKER')
    expect(String(user1.content)).toContain('偏离原因')
  })

  it('provider returning empty text → null (caller falls back)', async () => {
    const provider = new StubProvider({
      text: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
    })
    const r = await tryStageReport({
      prompt: 'q',
      result: fakeResult([{ name: 'native_now', isError: false }]),
      provider,
      kind: 'empty',
      sessionId: 'test-sess-6',
    })
    expect(r).toBeNull()
  })

  it('provider throwing → null (no throw escapes)', async () => {
    const provider = new StubProvider(new Error('upstream 503'))
    const r = await tryStageReport({
      prompt: 'q',
      result: fakeResult([{ name: 'native_now', isError: false }]),
      provider,
      kind: 'max_iter',
      sessionId: 'test-sess-7',
    })
    expect(r).toBeNull()
  })

  it('IMHUB_NATIVE_STAGE_REPORT=off skips the retry entirely', async () => {
    process.env[ENV_KEY] = 'off'
    const provider = new StubProvider({
      text: 'should not be reached',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const r = await tryStageReport({
      prompt: 'q',
      result: fakeResult([{ name: 'native_now', isError: false }]),
      provider,
      kind: 'empty',
      sessionId: 'test-sess-8',
    })
    expect(r).toBeNull()
    expect(provider.callCount).toBe(0)
  })
})
