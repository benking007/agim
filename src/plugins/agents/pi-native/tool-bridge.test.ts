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
})
