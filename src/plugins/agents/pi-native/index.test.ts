// Drive NativeAgentAdapter through agim's AgentAdapter contract with an
// injected faux model binding (provider/auth resolution is tested separately).

import { JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { type NativeModelBinding, NativeAgentAdapter } from './index.js'

const regs: Array<{ unregister(): void }> = []
afterEach(() => {
  while (regs.length) regs.pop()?.unregister()
})
function bindingFrom(model: Model<string>): NativeModelBinding {
  return { model, getApiKeyAndHeaders: async () => ({ apiKey: 'test', headers: {} }) }
}
function bindingFromFaux(reg: ReturnType<typeof registerFauxProvider>): NativeModelBinding {
  const model = reg.getModel()
  if (!model) throw new Error('faux provider did not expose a model')
  return bindingFrom(model)
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

async function withReliabilityEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AGIM_RELIABILITY_LOOP
  if (value === undefined) delete process.env.AGIM_RELIABILITY_LOOP
  else process.env.AGIM_RELIABILITY_LOOP = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.AGIM_RELIABILITY_LOOP
    else process.env.AGIM_RELIABILITY_LOOP = prev
  }
}

describe('NativeAgentAdapter (agim AgentAdapter contract)', () => {
  it('yields final assistant text', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('hi from pi engine')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
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
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
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
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt('s3', 'write', undefined, { planMode: true }))
    expect(sink).toEqual([])
    expect(out).toContain('blocked')
  })

  it('reports unavailable and throws cleanly when no backend is configured', async () => {
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => null,
    })
    expect(await adapter.isAvailable()).toBe(false)
    // sendPrompt must never throw silently — it yields a visible notice instead.
    const out = await collect(adapter.sendPrompt('s4', 'hi'))
    expect(out).toContain('未配置可用的大模型 API')
  })

  it('yields a visible error instead of throwing when the turn fails', async () => {
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      // resolveModel throws → must be caught and surfaced, not silent.
      resolveModel: async () => {
        throw new Error('boom-provider-down')
      },
    })
    const out = await collect(adapter.sendPrompt('s8', 'hi'))
    expect(out).toContain('Agim Agent 本轮出错')
    expect(out).toContain('boom-provider-down')
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
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
      // deny-all gate
      resolveApprovalGate: () => async () => 'deny',
    })
    const out = await collect(adapter.sendPrompt('s5', 'run something'))
    expect(ran).toEqual([]) // gate blocked execution
    expect(out).toContain('denied')
  })

  it('caps tool-call rounds at maxIterations (runaway guard)', async () => {
    const reg = faux()
    // The model loops forever, always emitting another tool call.
    reg.setResponses(
      Array.from({ length: 8 }, (_v, i) =>
        fauxAssistantMessage(fauxToolCall('spin', {}, { id: `r${i}` }), { stopReason: 'toolUse' }),
      ),
    )
    const ran: number[] = []
    const tool: ToolDef = { name: 'spin', description: 'spins', parameters: { type: 'object', properties: {}, required: [] } }
    const dispatch: ToolDispatcher = async () => {
      ran.push(1)
      return { text: 'spun', isError: false }
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
      maxIterations: 3,
    })
    const out = await collect(adapter.sendPrompt('s6', 'spin forever'))
    expect(ran.length).toBe(3) // stopped at the cap instead of looping out the queue
    expect(out).toContain('最大迭代')
  })

  it('returns a readable recap when tools ran but final text is empty', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('mcp__agim__list_skills', {}, { id: 'ls1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(''),
    ])
    const tool: ToolDef = {
      name: 'mcp__agim__list_skills',
      description: 'list skill names',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    const dispatch: ToolDispatcher = async () => ({ text: 'skills: foo,bar', isError: false })
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt('s-empty', '有什么 skills 可用'))
    expect(out).toContain('这一轮有执行工具')
    expect(out).toContain('mcp__agim__list_skills')
    expect(out).toContain('最后一步结果摘要')
    expect(out).not.toContain('本轮没有产出文本回复')
  })

  it('stops on a stuck loop (same tool + args erroring 3x) before max_iter', async () => {
    const reg = faux()
    reg.setResponses(
      Array.from({ length: 8 }, (_v, i) =>
        fauxAssistantMessage(fauxToolCall('flaky', {}, { id: `s${i}` }), { stopReason: 'toolUse' }),
      ),
    )
    let calls = 0
    const tool: ToolDef = { name: 'flaky', description: 'always fails', parameters: { type: 'object', properties: {}, required: [] } }
    const dispatch: ToolDispatcher = async () => {
      calls += 1
      return { text: 'upstream 503', isError: true } // same error every time
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
      maxIterations: 50, // high — stuck-loop must fire first
    })
    const out = await collect(adapter.sendPrompt('s7', 'do the flaky thing'))
    expect(calls).toBe(3) // exact stuck-loop window
    expect(out).toContain('死循环')
  })

  it('forwards provider stream options (retries / timeout / cache) to the provider', async () => {
    const reg = faux()
    let seen: { maxRetries?: number; maxRetryDelayMs?: number; timeoutMs?: number; cacheRetention?: string } | undefined
    reg.setResponses([
      (_ctx, options) => {
        seen = options as typeof seen
        return fauxAssistantMessage('ok')
      },
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      streamOptions: { maxRetries: 4, maxRetryDelayMs: 12345, timeoutMs: 67890, cacheRetention: 'long' },
    })
    expect(await collect(adapter.sendPrompt('so', 'hi'))).toBe('ok')
    expect(seen?.maxRetries).toBe(4)
    expect(seen?.maxRetryDelayMs).toBe(12345)
    expect(seen?.timeoutMs).toBe(67890)
    expect(seen?.cacheRetention).toBe('long')
  })

  it('handles /models and /model directly without sending them to the LLM', async () => {
    const reg = faux()
    let seenModel: string | undefined
    reg.setResponses([
      (_ctx) => fauxAssistantMessage('after switch'),
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async (opts) => {
        seenModel = opts?.model
        return bindingFromFaux(reg)
      },
      listModels: () => [
        { name: 'deepseek-agim', providerType: 'openai-compat', model: 'deepseek-chat' },
        { name: 'qwen-agim', providerType: 'openai-compat', model: 'qwen-max' },
      ],
    })
    const list = await collect(adapter.sendPrompt('slash', '/models'))
    expect(list).toContain('deepseek-agim')
    expect(list).toContain('qwen-agim')

    const switched = await collect(adapter.sendPrompt('slash', '/model qwen-agim'))
    expect(switched).toContain('模型已切换')
    expect(await collect(adapter.sendPrompt('slash', 'hi'))).toBe('after switch')
    expect(seenModel).toBe('qwen-agim')
  })

  it('switches direct /model by list index', async () => {
    const reg = faux()
    let seenModel: string | undefined
    reg.setResponses([
      (_ctx) => fauxAssistantMessage('indexed switch'),
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async (opts) => {
        seenModel = opts?.model
        return bindingFromFaux(reg)
      },
      listModels: () => [
        { name: 'deepseek-agim', providerType: 'openai-compat', model: 'deepseek-chat' },
        { name: 'qwen-agim', providerType: 'openai-compat', model: 'qwen-max' },
      ],
    })

    const switched = await collect(adapter.sendPrompt('slash-index', '/model #2'))
    expect(switched).toContain('qwen-agim')
    expect(await collect(adapter.sendPrompt('slash-index', 'hi'))).toBe('indexed switch')
    expect(seenModel).toBe('qwen-agim')
  })

  it('keeps trivial chat out of the reliability layer by default', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('plain hello')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const out = await withReliabilityEnv(undefined, () => collect(adapter.sendPrompt('plain-chat', 'hi')))
    expect(out).toBe('plain hello')
  })

  it('marks coding work UNVERIFIED when no verifier evidence exists', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('已修复这个 bug。')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const out = await withReliabilityEnv(undefined, () => collect(adapter.sendPrompt('code-unverified', '修复这个 bug')))
    expect(out).toContain('Status: UNVERIFIED')
    expect(out).toContain('没有看到测试')
    expect(out).toContain('已修复这个 bug')
  })

  it('marks coding work SUCCESS when a verifier-like tool passes', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('native_exec', { command: 'npm test' }, { id: 'test1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('测试通过，已完成。'),
    ])
    const tool: ToolDef = {
      name: 'native_exec',
      description: 'exec',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }
    const dispatch: ToolDispatcher = async () => ({ text: 'PASS: 12 tests passed', isError: false })
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await withReliabilityEnv(undefined, () => collect(adapter.sendPrompt('code-success', '修复 bug 并运行测试')))
    expect(out).toContain('Status: SUCCESS')
    expect(out).toContain('verifier +1')
    expect(out).toContain('测试通过，已完成')
  })

  it('generalizes to research with source evidence', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('native_web_search', { query: 'market size' }, { id: 's1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('基于检索结果，市场正在增长。'),
    ])
    const tool: ToolDef = {
      name: 'native_web_search',
      description: 'search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }
    const dispatch: ToolDispatcher = async () => ({ text: 'source: market report result', isError: false })
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await withReliabilityEnv(undefined, () => collect(adapter.sendPrompt('research-success', '做一个市场调研报告')))
    expect(out).toContain('Status: SUCCESS')
    expect(out).toContain('source +1')
  })

  it('treats investment plans without source evidence as UNVERIFIED drafts', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('投资计划：分散配置。风险：市场波动会造成回撤。')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const out = await withReliabilityEnv(undefined, () => collect(adapter.sendPrompt('invest-unverified', '帮我做一个投资计划')))
    expect(out).toContain('Status: UNVERIFIED')
    expect(out).toContain('缺少来源证据')
  })

  it('compacts an over-budget durable session before the next turn', async () => {
    // Tiny context window → turn-1 usage trips shouldCompact at the start of turn 2.
    const reg = registerFauxProvider({ models: [{ id: 'tiny', contextWindow: 200 }] })
    regs.push(reg)
    reg.setResponses([fauxAssistantMessage('t1')])
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-ad-'))
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
    })
    await collect(adapter.sendPrompt('cmp', 'q1'))
    // Turn 2 is over budget → an extra summary call fires before the turn itself.
    reg.appendResponses([fauxAssistantMessage('history summary'), fauxAssistantMessage('t2')])
    expect(await collect(adapter.sendPrompt('cmp', 'q2'))).toBe('t2')
    // The durable session now carries a compaction entry.
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((m) => m.id === 'cmp')
    expect(meta).toBeDefined()
    if (!meta) throw new Error('missing cmp session metadata')
    const entries = await (await repo.open(meta)).getEntries()
    expect(entries.some((e) => e.type === 'compaction')).toBe(true)
  })

  it('skips compaction when disabled (no extra summary call)', async () => {
    const reg = registerFauxProvider({ models: [{ id: 'tiny', contextWindow: 200 }] })
    regs.push(reg)
    // Only two turn responses queued — if compaction fired it would starve the queue.
    reg.setResponses([fauxAssistantMessage('t1'), fauxAssistantMessage('t2')])
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-ad-'))
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
      compactionEnabled: false,
    })
    await collect(adapter.sendPrompt('nc', 'q1'))
    expect(await collect(adapter.sendPrompt('nc', 'q2'))).toBe('t2')
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((m) => m.id === 'nc')
    if (!meta) throw new Error('missing nc session metadata')
    const entries = await (await repo.open(meta)).getEntries()
    expect(entries.some((e) => e.type === 'compaction')).toBe(false)
  })
})
