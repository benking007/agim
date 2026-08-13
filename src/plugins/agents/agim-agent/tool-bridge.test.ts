// Bridge agim ToolDef[] + ToolDispatcher onto pi AgentTool[] and drive it
// through a real pi AgentHarness with a faux provider.

import { AgentHarness, JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { DispatcherResult, ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { agimToolsToPi } from './tool-bridge.js'

const regs: Array<{ unregister(): void }> = []
afterEach(() => {
  while (regs.length) regs.pop()?.unregister()
})
function faux() {
  const r = registerFauxProvider()
  regs.push(r)
  return r
}
async function harness(model: Model<string>, tools: ReturnType<typeof agimToolsToPi>) {
  const root = mkdtempSync(join(tmpdir(), 'agim-bridge-'))
  const env = new NodeExecutionEnv({ cwd: root })
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root })
  const session = await repo.create({ cwd: root })
  return new AgentHarness({ env, session, model, tools })
}

const QUOTE_TOOL: ToolDef = {
  name: 'fin_data_quote',
  description: 'realtime quote',
  parameters: {
    type: 'object',
    properties: { symbol: { type: 'string' }, period: { type: 'string', enum: ['d', 'w', 'm'] } },
    required: ['symbol'],
  },
}

describe('Agim Agent tool-bridge (agim ToolDef + dispatcher → pi AgentTool)', () => {
  it('routes a model tool call through the agim dispatcher with parsed args', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = []
    const dispatch: ToolDispatcher = async (call): Promise<DispatcherResult> => {
      seen.push({ name: call.name, args: call.arguments })
      return { text: `quote:${call.arguments.symbol}`, isError: false }
    }
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('fin_data_quote', { symbol: '600519.SH', period: 'd' }, { id: 'q1' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ])
    const tools = agimToolsToPi([QUOTE_TOOL], dispatch, { parallelSafe: () => true })
    await (await harness(reg.getModel()!, tools)).prompt('quote it')
    expect(seen).toEqual([{ name: 'fin_data_quote', args: { symbol: '600519.SH', period: 'd' } }])
    expect(tools[0]!.executionMode).toBe('parallel')
  })

  it('translates a dispatcher isError result into a thrown (error) tool result', async () => {
    const dispatch: ToolDispatcher = async () => ({ text: 'upstream 503', isError: true })
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('fin_data_quote', { symbol: 'x' }, { id: 'q1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('recovered'),
    ])
    const tools = agimToolsToPi([QUOTE_TOOL], dispatch)
    let sawError = false
    const h = await harness(reg.getModel()!, tools)
    h.on('tool_result', (ev: { isError?: boolean }) => {
      if (ev.isError) sawError = true
      return undefined
    })
    const final = await h.prompt('go')
    expect(sawError).toBe(true)
    expect(JSON.stringify(final.content)).toContain('recovered') // loop survives the error
    expect(tools[0]!.executionMode).toBe('sequential') // default when no parallelSafe
  })

  it('truncates an oversized tool result (AGIM_NATIVE_TOOL_RESULT_MAX_CHARS)', async () => {
    const prev = process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS
    process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS = '50'
    try {
      const big = 'x'.repeat(5000)
      const dispatch: ToolDispatcher = async () => ({ text: big, isError: false })
      const [tool] = agimToolsToPi([QUOTE_TOOL], dispatch)
      const out = await tool!.execute('c1', { symbol: 'x' }, new AbortController().signal)
      const text = (out.content[0] as { text: string }).text
      expect(text.length).toBeLessThan(big.length)
      expect(text).toContain('输出已截断')
      expect(text).toContain('AGIM_NATIVE_TOOL_RESULT_MAX_CHARS')
    } finally {
      if (prev === undefined) delete process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS
      else process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS = prev
    }
  })

  it('refuses missing required args before dispatch (schema pre-check)', async () => {
    let dispatched = 0
    const dispatch: ToolDispatcher = async () => {
      dispatched += 1
      return { text: 'should not run', isError: false }
    }
    const [tool] = agimToolsToPi([QUOTE_TOOL], dispatch)
    await expect(tool!.execute('c1', {}, new AbortController().signal)).rejects.toThrow(/validation failed/)
    expect(dispatched).toBe(0)
  })

  it('schema pre-check can be disabled', async () => {
    const prev = process.env.AGIM_TOOL_SCHEMA_VALIDATE
    process.env.AGIM_TOOL_SCHEMA_VALIDATE = 'off'
    try {
      let dispatched = 0
      const dispatch: ToolDispatcher = async () => {
        dispatched += 1
        return { text: 'ran without symbol', isError: false }
      }
      const [tool] = agimToolsToPi([QUOTE_TOOL], dispatch)
      const out = await tool!.execute('c1', {}, new AbortController().signal)
      expect(dispatched).toBe(1)
      expect((out.content[0] as { text: string }).text).toBe('ran without symbol')
    } finally {
      if (prev === undefined) delete process.env.AGIM_TOOL_SCHEMA_VALIDATE
      else process.env.AGIM_TOOL_SCHEMA_VALIDATE = prev
    }
  })

  it('times out a hung tool (AGIM_NATIVE_TOOL_TIMEOUT_MS) and surfaces an error', async () => {
    const prev = process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
    process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = '20'
    try {
      // Never resolves on its own; resolves only when the timeout aborts it
      // (so the test doesn't leak a pending promise).
      const dispatch: ToolDispatcher = (_call, sig) =>
        new Promise((resolve) => {
          sig.addEventListener('abort', () => resolve({ text: 'aborted', isError: true }), { once: true })
        })
      const [tool] = agimToolsToPi([QUOTE_TOOL], dispatch)
      await expect(tool!.execute('c1', { symbol: 'x' }, new AbortController().signal)).rejects.toThrow(/超时/)
    } finally {
      if (prev === undefined) delete process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
      else process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = prev
    }
  })

  it('waits for mutation-capable dispatchers to settle after timeout abort', async () => {
    const prev = process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
    process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = '20'
    try {
      const mutation: ToolDef = {
        name: 'agim_write_file',
        description: 'write',
        parameters: { type: 'object', properties: {}, required: [] },
      }
      const dispatch: ToolDispatcher = (_call, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => resolve({ text: 'aborted after cleanup', isError: true }), 40)
        }, { once: true })
      })
      const [tool] = agimToolsToPi([mutation], dispatch)
      const started = performance.now()
      await expect(tool.execute('mutation-timeout', {}, new AbortController().signal)).rejects.toThrow(/超时/)
      expect(performance.now() - started).toBeGreaterThanOrEqual(50)
    } finally {
      if (prev === undefined) delete process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
      else process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = prev
    }
  })

  it('prefers mutation success after wall abort (avoids no_active_loop after loop_verdict)', async () => {
    const prev = process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
    process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = '20'
    try {
      const mutation: ToolDef = {
        name: 'mcp__agim__loop_verdict',
        description: 'verdict',
        parameters: { type: 'object', properties: {}, required: [] },
      }
      const dispatch: ToolDispatcher = (_call, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => resolve({
            text: '{"status":"ended","endReason":"objective_met"}',
            isError: false,
          }), 40)
        }, { once: true })
      })
      const [tool] = agimToolsToPi([mutation], dispatch)
      const out = await tool.execute('mutation-success-after-timeout', {}, new AbortController().signal)
      const text = (out.content[0] as { text: string }).text
      expect(text).toContain('objective_met')
      expect(text).toContain('副作用已成功提交')
    } finally {
      if (prev === undefined) delete process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
      else process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = prev
    }
  })

  it('returns promptly on outer abort even when the dispatcher ignores its signal', async () => {
    const slowTool: ToolDef = { ...QUOTE_TOOL, timeoutMs: 0 }
    const dispatch: ToolDispatcher = async () => await new Promise<never>(() => {})
    const [tool] = agimToolsToPi([slowTool], dispatch, { parallelSafe: () => true })
    const ctrl = new AbortController()
    const run = tool!.execute('c1', { symbol: 'x' }, ctrl.signal)
    const t0 = performance.now()
    ctrl.abort()

    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(performance.now() - t0).toBeLessThan(100)
  })

  it('honors a per-tool timeoutMs=0 opt-out (no cap even with a tiny env timeout)', async () => {
    const prev = process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
    process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = '10'
    try {
      const slowTool: ToolDef = { ...QUOTE_TOOL, timeoutMs: 0 }
      const dispatch: ToolDispatcher = async () => {
        await new Promise((r) => setTimeout(r, 40)) // longer than the env cap
        return { text: 'slow ok', isError: false }
      }
      const [tool] = agimToolsToPi([slowTool], dispatch)
      const out = await tool!.execute('c1', { symbol: 'x' }, new AbortController().signal)
      expect((out.content[0] as { text: string }).text).toBe('slow ok')
    } finally {
      if (prev === undefined) delete process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS
      else process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS = prev
    }
  })
})
