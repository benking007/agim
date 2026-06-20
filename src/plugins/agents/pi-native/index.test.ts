// Drive PiNativeAgentAdapter through agim's AgentAdapter contract with an
// injected faux model binding (provider/auth resolution is tested separately).

import { fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { type PiModelBinding, PiNativeAgentAdapter } from './index.js'

const regs: Array<{ unregister(): void }> = []
afterEach(() => {
  while (regs.length) regs.pop()?.unregister()
})
function bindingFrom(model: Model<string>): PiModelBinding {
  return { model, getApiKeyAndHeaders: async () => ({ apiKey: 'test', headers: {} }) }
}
function faux() {
  const r = registerFauxProvider()
  regs.push(r)
  return r
}
async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const c of gen) out += c
  return out
}

describe('PiNativeAgentAdapter (agim AgentAdapter contract)', () => {
  it('yields final assistant text', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('hi from pi engine')])
    const adapter = new PiNativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFrom(reg.getModel()!),
    })
    expect(await collect(adapter.sendPrompt('s1', 'hi'))).toBe('hi from pi engine')
  })

  it('pi owns durable history: 2nd turn sees turn-1 with no history arg', async () => {
    const reg = faux()
    const userCounts: number[] = []
    reg.setResponses([
      (ctx: { messages: Array<{ role: string }> }) => {
        userCounts.push(ctx.messages.filter((m) => m.role === 'user').length)
        return fauxAssistantMessage('t1')
      },
      (ctx: { messages: Array<{ role: string }> }) => {
        userCounts.push(ctx.messages.filter((m) => m.role === 'user').length)
        return fauxAssistantMessage('t2')
      },
    ])
    const adapter = new PiNativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFrom(reg.getModel()!),
    })
    await collect(adapter.sendPrompt('same', 'q1'))
    await collect(adapter.sendPrompt('same', 'q2'))
    expect(userCounts).toEqual([1, 2])
  })

  it('honors opts.planMode by blocking a mutating tool', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('native_write', { path: '/x' }, { id: 'w1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('blocked'),
    ])
    const sink: string[] = []
    const tool: ToolDef = { name: 'native_write', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
    const dispatch: ToolDispatcher = async (call) => {
      sink.push(String(call.arguments.path))
      return { text: 'wrote', isError: false }
    }
    const adapter = new PiNativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFrom(reg.getModel()!),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt('s3', 'write', undefined, { planMode: true }))
    expect(sink).toEqual([])
    expect(out).toContain('blocked')
  })

  it('reports unavailable and throws cleanly when no backend is configured', async () => {
    const adapter = new PiNativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => null,
    })
    expect(await adapter.isAvailable()).toBe(false)
    await expect(collect(adapter.sendPrompt('s4', 'hi'))).rejects.toThrow(/no LLM backend/)
  })

  it('consults the approval gate and blocks a denied tool', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('native_exec', { cmd: 'rm -rf /' }, { id: 'x1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('denied, did nothing'),
    ])
    const ran: string[] = []
    const tool: ToolDef = { name: 'native_exec', description: 'exec', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }
    const dispatch: ToolDispatcher = async (call) => {
      ran.push(String(call.arguments.cmd))
      return { text: 'ran', isError: false }
    }
    const adapter = new PiNativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFrom(reg.getModel()!),
      resolveTools: () => ({ tools: [tool], dispatch }),
      // deny-all gate
      resolveApprovalGate: () => async () => 'deny',
    })
    const out = await collect(adapter.sendPrompt('s5', 'run something'))
    expect(ran).toEqual([]) // gate blocked execution
    expect(out).toContain('denied')
  })
})
