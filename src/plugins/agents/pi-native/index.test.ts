// Drive NativeAgentAdapter through agim's AgentAdapter contract with an
// injected faux model binding (provider/auth resolution is tested separately).

import { JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  it('stores pi session directories and JSONL files with private POSIX modes', async () => {
    if (process.platform === 'win32') return
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('private')])
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-mode-'))
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
    })
    await collect(adapter.sendPrompt('private-session', 'hi'))

    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((m) => m.id === 'private-session')
    expect(meta).toBeDefined()
    if (!meta) throw new Error('missing private session metadata')
    expect(statSync(dirname(meta.path)).mode & 0o777).toBe(0o700)
    expect(statSync(meta.path).mode & 0o777).toBe(0o600)
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

  it('injects ephemeral context into provider requests without persisting it', async () => {
    const reg = faux()
    let providerUserText = ''
    reg.setResponses([
      (ctx) => {
        const user = [...ctx.messages].reverse().find((message) => message.role === 'user')
        providerUserText = typeof user?.content === 'string'
          ? user.content
          : (user?.content ?? []).map((block) => block.type === 'text' ? block.text : '').join('')
        return fauxAssistantMessage('ok')
      },
    ])
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-ephemeral-'))
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
    })
    await collect(adapter.sendPrompt('ephemeral', 'raw user prompt', undefined, {
      ephemeralContext: '[active goal]\nShip the release',
    }))

    expect(providerUserText).toContain('[active goal]')
    expect(providerUserText).toContain('raw user prompt')
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((item) => item.id === 'ephemeral')
    if (!meta) throw new Error('missing ephemeral session')
    const entries = await (await repo.open(meta)).getEntries()
    const persistedUsers = entries
      .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
      .map((entry) => entry.message.content)
    expect(JSON.stringify(persistedUsers)).toContain('raw user prompt')
    expect(JSON.stringify(persistedUsers)).not.toContain('[active goal]')
  })

  it('invalidates stale cached metadata when the JSONL file was removed', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('recovered')])
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-stale-meta-'))
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
    })
    expect(await collect(adapter.sendPrompt('stale-meta', 'q1'))).toBe('first')

    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((item) => item.id === 'stale-meta')
    if (!meta) throw new Error('missing stale-meta session')
    unlinkSync(meta.path)

    expect(await collect(adapter.sendPrompt('stale-meta', 'q2'))).toBe('recovered')
    expect((await repo.list()).some((item) => item.id === 'stale-meta')).toBe(true)
  })

  it('honors opts.planMode by blocking a mutating tool', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('native_write_file', { path: '/x', content: 'x' }, { id: 'w1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('blocked'),
    ])
    const sink: string[] = []
    const tool: ToolDef = {
      name: 'native_write_file',
      description: 'write',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    }
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

  it('fails closed for unknown external tools in Plan Mode', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('mcp__external__write', { value: 'x' }, { id: 'm1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('blocked external mutation'),
    ])
    let dispatched = false
    const tool: ToolDef = {
      name: 'mcp__external__write',
      description: 'unknown external mutation',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-plan-mcp-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => {
          dispatched = true
          return { text: 'wrote', isError: false }
        },
      }),
    })

    const out = await collect(adapter.sendPrompt('plan-mcp', 'plan only', undefined, { planMode: true }))
    expect(dispatched).toBe(false)
    expect(out).toContain('blocked external mutation')
  })

  it('applies an approved plan exit within the same harness turn', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('native_exit_plan_mode', { plan: '- write /x' }, { id: 'p1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('native_write_file', { path: '/x', content: 'x' }, { id: 'w1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('implemented'),
    ])
    let planActive = true
    const dispatched: string[] = []
    const tools: ToolDef[] = [
      {
        name: 'native_exit_plan_mode',
        description: 'exit plan',
        parameters: {
          type: 'object',
          properties: { plan: { type: 'string' } },
          required: ['plan'],
        },
      },
      {
        name: 'native_write_file',
        description: 'write',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    ]
    const dispatch: ToolDispatcher = async (call) => {
      dispatched.push(call.name)
      if (call.name === 'native_exit_plan_mode') planActive = false
      return { text: call.name === 'native_exit_plan_mode' ? 'approved' : 'wrote', isError: false }
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-plan-exit-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools, dispatch }),
      resolveApprovalGate: () => async (call) =>
        call.name === 'native_exit_plan_mode' || !planActive ? 'allow' : 'deny',
    })

    const out = await collect(adapter.sendPrompt('plan-exit', 'plan then implement', undefined, { planMode: true }))
    expect(dispatched).toEqual(['native_exit_plan_mode', 'native_write_file'])
    expect(out).toBe('implemented')
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

  it('surfaces a provider error (stopReason=error) as a friendly retry notice, not an empty-content recap', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'socket hang up' }),
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    let outcome: string | undefined
    const out = await collect(adapter.sendPrompt('perr', 'hi', undefined, {
      onOutcome: (value) => { outcome = value.status },
    }))
    expect(out).toContain('网络或模型服务中断')
    expect(out).toContain('socket hang up') // the real cause is surfaced
    expect(out).toContain('重试')
    // must NOT be misreported as the model returning empty content
    expect(out).not.toContain('没有产出可见回复')
    expect(out).not.toContain('模型返回了空内容')
    expect(outcome).toBe('error')
  })

  it('surfaces a mid-stream provider throw (undici "terminated") as a retry notice', async () => {
    const reg = faux()
    reg.setResponses([
      () => {
        throw new Error('terminated')
      },
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const out = await collect(adapter.sendPrompt('perr2', 'hi'))
    expect(out).toContain('网络或模型服务中断')
    expect(out).toContain('terminated')
    expect(out).not.toContain('没有产出可见回复')
  })

  it('reports external cancellation as aborted even when partial text exists', async () => {
    const ctrl = new AbortController()
    const reg = faux()
    reg.setResponses([
      () => {
        ctrl.abort()
        return fauxAssistantMessage('partial text', { stopReason: 'aborted' })
      },
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-partial-abort-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const outcomes: string[] = []
    const out = await collect(adapter.sendPrompt('partial-abort', 'hi', undefined, {
      signal: ctrl.signal,
      onOutcome: (value) => { outcomes.push(value.status) },
    }))
    expect(out).toContain('本轮已被取消')
    expect(outcomes.at(-1)).toBe('aborted')
  })

  it('serializes concurrent turns on the same session id (no interleaved harness writes)', async () => {
    const reg = faux()
    let active = 0
    let maxActive = 0
    const slow = (text: string) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 30))
      active -= 1
      return fauxAssistantMessage(text)
    }
    reg.setResponses([slow('a'), slow('b')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const [o1, o2] = await Promise.all([
      collect(adapter.sendPrompt('dup', 'q1')),
      collect(adapter.sendPrompt('dup', 'q2')),
    ])
    expect(maxActive).toBe(1) // same session never ran two provider calls at once
    expect([o1, o2].sort()).toEqual(['a', 'b'])
  })

  it('does not serialize across different session ids (per-key lock, not global)', async () => {
    const reg = faux()
    let active = 0
    let maxActive = 0
    const slow = (text: string) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 30))
      active -= 1
      return fauxAssistantMessage(text)
    }
    reg.setResponses([slow('a'), slow('b')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    await Promise.all([
      collect(adapter.sendPrompt('k1', 'q')),
      collect(adapter.sendPrompt('k2', 'q')),
    ])
    expect(maxActive).toBe(2) // different sessions still run in parallel
  })

  it('aborts an active harness turn through opts.signal', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('wait_forever', {}, { id: 'wait1' }), { stopReason: 'toolUse' }),
    ])
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const tool: ToolDef = {
      name: 'wait_forever',
      description: 'wait',
      parameters: { type: 'object', properties: {}, required: [] },
      timeoutMs: 0,
    }
    const dispatch: ToolDispatcher = async () => {
      notifyStarted()
      return await new Promise<never>(() => {}) // deliberately ignores AbortSignal
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-abort-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch, parallelSafe: () => true }),
    })
    const ctrl = new AbortController()
    let outcome: string | undefined
    const run = collect(adapter.sendPrompt('abort-active', 'wait', undefined, {
      signal: ctrl.signal,
      onOutcome: (value) => { outcome = value.status },
    }))
    await started
    const t0 = performance.now()
    ctrl.abort()
    const out = await run

    expect(performance.now() - t0).toBeLessThan(250)
    expect(out).toContain('本轮已被取消')
    expect(outcome).toBe('aborted')
  })

  it('stops a runaway active loop at the configured run timeout', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('wait_forever', {}, { id: 'wait-timeout' }), { stopReason: 'toolUse' }),
    ])
    const tool: ToolDef = {
      name: 'wait_forever',
      description: 'wait',
      parameters: { type: 'object', properties: {}, required: [] },
      timeoutMs: 0,
    }
    const dispatch: ToolDispatcher = async () => await new Promise<never>(() => {})
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-run-timeout-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch, parallelSafe: () => true }),
      resolveRunTimeoutMs: () => 30,
    })
    const t0 = performance.now()
    let outcome: string | undefined
    const out = await collect(adapter.sendPrompt('run-timeout', 'wait', undefined, {
      onOutcome: (value) => { outcome = value.status },
    }))

    expect(performance.now() - t0).toBeLessThan(250)
    expect(out).toContain('运行超过')
    expect(out).toContain('AGIM_NATIVE_TURN_TIMEOUT_MS')
    expect(outcome).toBe('timeout')
  })

  it('cancels a queued same-session turn without waiting for the active turn', async () => {
    const reg = faux()
    let active = 0
    let maxActive = 0
    reg.setResponses([
      async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 120))
        active -= 1
        return fauxAssistantMessage('first')
      },
      async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        active -= 1
        return fauxAssistantMessage('third')
      },
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-queue-abort-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const first = collect(adapter.sendPrompt('queued', 'first'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const ctrl = new AbortController()
    ctrl.abort()
    const t0 = performance.now()
    const second = await collect(adapter.sendPrompt('queued', 'second', undefined, { signal: ctrl.signal }))

    expect(performance.now() - t0).toBeLessThan(50)
    expect(second).toContain('本轮已被取消')
    const third = collect(adapter.sendPrompt('queued', 'third'))
    expect(await first).toBe('first')
    expect(await third).toBe('third')
    expect(maxActive).toBe(1)
    expect(reg.state.callCount).toBe(2)
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

  it('enforces tool-call budget across parallel batches before dispatch', async () => {
    const reg = faux()
    const batch = (prefix: string, offset: number) => fauxAssistantMessage(
      [1, 2, 3].map((n) => fauxToolCall('step', { n: n + offset }, { id: `${prefix}${n}` })),
      { stopReason: 'toolUse' },
    )
    reg.setResponses([batch('a', 0), batch('b', 3), fauxAssistantMessage('unreachable')])
    let dispatchCount = 0
    const tool: ToolDef = {
      name: 'step',
      description: 'step',
      parameters: {
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
      },
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-tool-budget-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => {
          dispatchCount += 1
          return { text: 'ok', isError: false }
        },
        parallelSafe: () => true,
      }),
      maxIterations: 10,
      maxToolCalls: 3,
    })

    const out = await collect(adapter.sendPrompt('tool-budget', 'run batches'))
    expect(dispatchCount).toBe(3)
    expect(reg.state.callCount).toBe(2)
    expect(out).toContain('工具调用预算 3')
  })

  it('counts schema-invalid loops against the model-turn budget', async () => {
    const reg = faux()
    reg.setResponses(Array.from({ length: 6 }, (_v, i) =>
      fauxAssistantMessage(fauxToolCall('needs_arg', {}, { id: `bad${i}` }), { stopReason: 'toolUse' })))
    let dispatchCount = 0
    const tool: ToolDef = {
      name: 'needs_arg',
      description: 'needs arg',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-invalid-budget-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => {
          dispatchCount += 1
          return { text: 'unexpected', isError: false }
        },
      }),
      maxIterations: 2,
      maxToolCalls: 10,
    })

    const out = await collect(adapter.sendPrompt('invalid-budget', 'run invalid'))
    expect(dispatchCount).toBe(0)
    expect(reg.state.callCount).toBe(2)
    expect(out).toContain('最大迭代步数 2')
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
        fauxAssistantMessage(
          fauxToolCall('flaky', i % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 }, { id: `s${i}` }),
          { stopReason: 'toolUse' },
        ),
      ),
    )
    let calls = 0
    const tool: ToolDef = {
      name: 'flaky',
      description: 'always fails',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    }
    const dispatch: ToolDispatcher = async () => {
      calls += 1
      return { text: `upstream 503 request ${100000 + calls}`, isError: true }
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

  it('reports aggregate usage across every assistant turn in the tool loop', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('step', {}, { id: 'usage-step' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('final answer'),
    ])
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-usage-'))
    const tool: ToolDef = {
      name: 'step',
      description: 'step',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    let reported: { tokensInput?: number; tokensOutput?: number } | undefined
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => ({ text: 'tool result', isError: false }),
      }),
    })
    await collect(adapter.sendPrompt('usage-all-turns', 'run', undefined, {
      onUsage: (usage) => { reported = usage },
    }))

    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((item) => item.id === 'usage-all-turns')
    if (!meta) throw new Error('missing usage session')
    const entries = await (await repo.open(meta)).getEntries()
    const usages = entries
      .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
      .map((entry) => entry.message.usage)
    expect(usages).toHaveLength(2)
    expect(reported?.tokensInput).toBe(usages.reduce((sum, usage) => sum + usage.input, 0))
    expect(reported?.tokensOutput).toBe(usages.reduce((sum, usage) => sum + usage.output, 0))
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

  it('keeps normal answers unwrapped', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('plain hello')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const out = await collect(adapter.sendPrompt('plain-chat', 'hi'))
    expect(out).toBe('plain hello')
  })

  it('does not inject reliability status into coding answers without verifier evidence', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('已修复这个 bug。')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const out = await collect(adapter.sendPrompt('code-no-verifier', '修复这个 bug'))
    expect(out).toBe('已修复这个 bug。')
    expect(out).not.toContain('Status:')
    expect(out).not.toContain('没有看到测试')
  })

  it('keeps successful tool-backed answers unwrapped', async () => {
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
    const out = await collect(adapter.sendPrompt('tool-success', '修复 bug 并运行测试'))
    expect(out).toBe('测试通过，已完成。')
    expect(out).not.toContain('Status:')
  })

  it('appends diagnostics when tools fail but the model still returns text', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('flaky_lookup', { query: 'x' }, { id: 'f1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('我根据已有信息继续。'),
    ])
    const tool: ToolDef = {
      name: 'flaky_lookup',
      description: 'lookup',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }
    const dispatch: ToolDispatcher = async () => ({ text: 'upstream 503', isError: true })
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt('partial-diagnostic', '查一下'))
    expect(out).toContain('我根据已有信息继续。')
    expect(out).toContain('诊断')
    expect(out).toContain('flaky_lookup')
    expect(out).not.toContain('Status:')
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
