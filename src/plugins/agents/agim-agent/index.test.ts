// Drive NativeAgentAdapter through agim's AgentAdapter contract with an
// injected faux model binding (provider/auth resolution is tested separately).

import { JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { fauxAssistantMessage, fauxToolCall, type Model, registerFauxProvider } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { nativeSessionIndexPath } from '../../../core/agim-session-bind.js'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import {
  buildTodoDispatcher,
  clearTodoForThread,
} from '../../../core/llm/todo-dispatcher.js'
import { composeDeliveredAssistantText, type NativeModelBinding, NativeAgentAdapter } from './index.js'
import { _resetTurnSteer, dispatchTurnSteer } from '../../../core/turn-steer.js'
import { setLivePlanMode } from '../../../core/plan-mode-state.js'

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

describe('composeDeliveredAssistantText', () => {
  it('keeps a long mid-turn body when the last hop is only a short closure', () => {
    const body = `${'盘点条目：发现 A、B、C。'.repeat(10)}详细说明略。`
    const out = composeDeliveredAssistantText([body], '盘点完成。有任何需要深挖的方向随时说。')
    expect(out).toContain('盘点条目')
    expect(out).toContain('盘点完成')
  })

  it('rescues mid-turn body when the last hop is empty', () => {
    const body = '完整报告正文：'.padEnd(120, 'x')
    expect(composeDeliveredAssistantText([body], '')).toBe(body)
  })

  it('does not prepend mid-turn text when the final hop is already long', () => {
    const draft = '草稿：'.padEnd(100, 'a')
    const finals = '终稿完整报告：'.padEnd(250, 'b')
    expect(composeDeliveredAssistantText([draft], finals)).toBe(finals)
  })

  it('ignores tiny mid-turn fillers', () => {
    expect(composeDeliveredAssistantText(['稍等'], '最终结论很长'.padEnd(50, '。'))).toBe(
      '最终结论很长'.padEnd(50, '。'),
    )
  })
})

describe('NativeAgentAdapter (agim AgentAdapter contract)', () => {
  // Existing contract tests predate the todo-first gate; keep them focused
  // on harness behaviour and cover the gate in a dedicated suite below.
  const prevTodoGate = process.env.AGIM_TODO_GATE
  beforeEach(() => { process.env.AGIM_TODO_GATE = 'off' })
  afterEach(() => {
    if (prevTodoGate === undefined) delete process.env.AGIM_TODO_GATE
    else process.env.AGIM_TODO_GATE = prevTodoGate
    _resetTurnSteer()
  })

  it('yields final assistant text', async () => {
    const reg = faux()
    reg.setResponses([fauxAssistantMessage('hi from pi engine')])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    expect(await collect(adapter.sendPrompt('s1', 'hi'))).toBe('hi from pi engine')
  })

  it('absorbs a mid-turn steer before the next provider hop', async () => {
    const sessionId = 'steer-mid-turn'
    let secondHop = ''
    const reg = faux()
    let releaseTool!: () => void
    const held = new Promise<void>((resolve) => { releaseTool = resolve })
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('hold', {}, { id: 'h1' }), { stopReason: 'toolUse' }),
      (ctx) => {
        secondHop = JSON.stringify(ctx.messages.filter((m) => m.role === 'user'))
        return fauxAssistantMessage('adjusted after supplement')
      },
    ])
    const tool: ToolDef = {
      name: 'hold',
      description: 'hold until released',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    const dispatch: ToolDispatcher = async () => {
      const mode = await dispatchTurnSteer(`agim:${sessionId}`, 'also run the tests')
      expect(mode).toBe('live')
      await held
      return { text: 'held', isError: false }
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-steer-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const gen = adapter.sendPrompt(sessionId, 'do the work')
    const outP = collect(gen)
    await new Promise((r) => setTimeout(r, 30))
    releaseTool()
    const out = await outP
    expect(out).toContain('adjusted after supplement')
    expect(secondHop).toContain('also run the tests')
    expect(secondHop).toContain('本轮补充')
  })

  it('records threadId ↔ native JSONL session join without merging transcripts', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage('bound'),
      fauxAssistantMessage('bound-2'),
    ])
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-bind-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    await collect(adapter.sendPrompt('a2a-12', 'hi', undefined, {
      threadId: 'web-thread-1',
      platform: 'web',
      channelId: 'web',
      parentJobId: 12,
    }))
    await collect(adapter.sendPrompt('a2a-12', 'again', undefined, {
      threadId: 'web-thread-1',
      platform: 'web',
      channelId: 'web',
      parentJobId: 12,
    }))
    const raw = readFileSync(nativeSessionIndexPath(), 'utf8').trim().split('\n')
    const rows = raw.map((l) => JSON.parse(l) as {
      nativeSessionId: string
      threadId: string
      parentJobId?: number
    })
    const hits = rows.filter((r) => r.nativeSessionId === 'a2a-12')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.threadId).toBe('web-thread-1')
    expect(hits[0]?.parentJobId).toBe(12)
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
    const persistedUsers = entries.flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'user'
        ? [entry.message.content]
        : [])
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

  it('does not recreate a deleted active JSONL as a headerless public file', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('delete_session', {}, { id: 'delete1' }), { stopReason: 'toolUse' }),
    ])
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-active-delete-'))
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const tool: ToolDef = {
      name: 'delete_session',
      description: 'test-only delete',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => {
          const meta = (await repo.list()).find((item) => item.id === 'active-delete')
          if (!meta) throw new Error('missing active-delete session')
          unlinkSync(meta.path)
          return { text: 'deleted', isError: false }
        },
      }),
    })

    const failed = await collect(adapter.sendPrompt('active-delete', 'delete it'))
    expect(failed).toContain('Agim Agent 本轮出错')
    expect((await repo.list()).some((item) => item.id === 'active-delete')).toBe(false)

    reg.appendResponses([fauxAssistantMessage('recovered safely')])
    expect(await collect(adapter.sendPrompt('active-delete', 'retry'))).toBe('recovered safely')
    const recreated = (await repo.list()).find((item) => item.id === 'active-delete')
    expect(recreated).toBeDefined()
    if (recreated && process.platform !== 'win32') {
      expect(statSync(recreated.path).mode & 0o777).toBe(0o600)
    }
  })

  it('honors opts.planMode by blocking a mutating tool', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('agim_write_file', { path: '/x', content: 'x' }, { id: 'w1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('blocked'),
    ])
    const sink: string[] = []
    const tool: ToolDef = {
      name: 'agim_write_file',
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

  // Session-scoped thread keys (agim:<sessionId>) — avoid platform/threadId
  // opts so Bun tests do not trip the goals-DB fail-closed path
  // (better-sqlite3 unavailable → resolveGoalEvidence throws).
  it('todo-gate blocks mutating tools until a non-empty checklist exists', async () => {
    process.env.AGIM_TODO_GATE = 'on'
    const sessionId = 'todo-gate-sess'
    clearTodoForThread(`agim:${sessionId}`)
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('agim_write_file', { path: '/x', content: 'x' }, { id: 'w1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('need a plan first'),
    ])
    const sink: string[] = []
    const tool: ToolDef = {
      name: 'agim_write_file',
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
    const denied: string[] = []
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-todo-gate-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt(sessionId, 'write', undefined, {
      onToolActivity: (step) => {
        if (step.status === 'denied') denied.push(step.preview ?? '')
      },
    }))
    expect(sink).toEqual([])
    expect(denied.some((p) => p.includes('todo-gate'))).toBe(true)
    expect(out).toContain('need a plan first')
  })

  it('todo-gate allows mutations after agim_todo_write seeds a checklist', async () => {
    process.env.AGIM_TODO_GATE = 'on'
    const sessionId = 'todo-gate-sess-2'
    const threadKey = `agim:${sessionId}`
    clearTodoForThread(threadKey)
    const todo = buildTodoDispatcher(threadKey)
    await todo({
      id: 't0',
      name: 'agim_todo_write',
      arguments: { items: [{ content: 'write file', status: 'in_progress' }] },
    }, new AbortController().signal)

    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('agim_write_file', { path: '/ok', content: 'x' }, { id: 'w2' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('wrote after plan'),
    ])
    const sink: string[] = []
    const tool: ToolDef = {
      name: 'agim_write_file',
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
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-todo-gate-ok-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt(sessionId, 'write'))
    expect(sink).toEqual(['/ok'])
    expect(out).toContain('wrote after plan')
  })

  it('todo-gate allows read tools without a checklist', async () => {
    process.env.AGIM_TODO_GATE = 'on'
    const sessionId = 'todo-gate-read'
    clearTodoForThread(`agim:${sessionId}`)
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('agim_read_file', { path: '/r' }, { id: 'r1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('read ok'),
    ])
    const sink: string[] = []
    const tool: ToolDef = {
      name: 'agim_read_file',
      description: 'read',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }
    const dispatch: ToolDispatcher = async (call) => {
      sink.push(String(call.arguments.path))
      return { text: 'content', isError: false }
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-todo-gate-read-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    await collect(adapter.sendPrompt(sessionId, 'read'))
    expect(sink).toEqual(['/r'])
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
      fauxAssistantMessage(fauxToolCall('agim_exit_plan_mode', { plan: '- write /x' }, { id: 'p1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('agim_write_file', { path: '/x', content: 'x' }, { id: 'w1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('implemented'),
    ])
    let planActive = true
    const dispatched: string[] = []
    const tools: ToolDef[] = [
      {
        name: 'agim_exit_plan_mode',
        description: 'exit plan',
        parameters: {
          type: 'object',
          properties: { plan: { type: 'string' } },
          required: ['plan'],
        },
      },
      {
        name: 'agim_write_file',
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
      if (call.name === 'agim_exit_plan_mode') planActive = false
      return { text: call.name === 'agim_exit_plan_mode' ? 'approved' : 'wrote', isError: false }
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-plan-exit-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools, dispatch }),
      resolveApprovalGate: () => async (call) =>
        call.name === 'agim_exit_plan_mode' || !planActive ? 'allow' : 'deny',
    })

    const out = await collect(adapter.sendPrompt('plan-exit', 'plan then implement', undefined, { planMode: true }))
    expect(dispatched).toEqual(['agim_exit_plan_mode', 'agim_write_file'])
    expect(out).toBe('implemented')
  })

  it('honors mid-turn live Plan Mode off so writes are not hard-denied', async () => {
    const sessionId = 'plan-live-off'
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('agim_sleep_ms', { ms: 1 }, { id: 's1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('agim_write_file', { path: '/x', content: 'x' }, { id: 'w1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('implemented'),
    ])
    const dispatched: string[] = []
    const tools: ToolDef[] = [
      {
        name: 'agim_sleep_ms',
        description: 'sleep',
        parameters: {
          type: 'object',
          properties: { ms: { type: 'number' } },
          required: ['ms'],
        },
      },
      {
        name: 'agim_write_file',
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
      if (call.name === 'agim_sleep_ms') {
        setLivePlanMode(`agim:${sessionId}`, false)
      }
      return { text: 'ok', isError: false }
    }
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-plan-live-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools, dispatch }),
    })
    const out = await collect(adapter.sendPrompt(sessionId, 'plan then write', undefined, { planMode: true }))
    expect(dispatched).toEqual(['agim_sleep_ms', 'agim_write_file'])
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
      fauxAssistantMessage(fauxToolCall('agim_exec', { cmd: 'rm -rf /' }, { id: 'x1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('denied, did nothing'),
    ])
    const ran: string[] = []
    const tool: ToolDef = { name: 'agim_exec', description: 'exec', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }
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

  it('emits onToolActivity running→success and classifies skill-ish tools', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('agim_read', { path: 'a.ts' }, { id: 'tc-read' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('skill_accessibility', { query: 'a11y' }, { id: 'tc-skill' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('done'),
    ])
    const toolRead: ToolDef = {
      name: 'agim_read',
      description: 'read',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }
    const toolSkill: ToolDef = {
      name: 'skill_accessibility',
      description: 'skill',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }
    const steps: Array<{ id: string; kind: string; label: string; status: string }> = []
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-activity-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [toolRead, toolSkill],
        dispatch: async (call) => ({ text: `ok:${call.name}`, isError: false }),
      }),
    })
    await collect(adapter.sendPrompt('activity-steps', 'read then skill', undefined, {
      onToolActivity: (step) => {
        steps.push({ id: step.id, kind: step.kind, label: step.label, status: step.status })
      },
    }))
    expect(steps).toEqual([
      { id: 'tc-read', kind: 'tool', label: 'agim_read', status: 'running' },
      { id: 'tc-read', kind: 'tool', label: 'agim_read', status: 'success' },
      { id: 'tc-skill', kind: 'skill', label: 'skill_accessibility', status: 'running' },
      { id: 'tc-skill', kind: 'skill', label: 'skill_accessibility', status: 'success' },
    ])
  })

  it('collapses progressive agim_todo_write activity onto one plan step id', async () => {
    const itemsA = [
      { content: 'one', status: 'in_progress' as const },
      { content: 'two', status: 'pending' as const },
    ]
    const itemsB = [
      { content: 'one', status: 'completed' as const },
      { content: 'two', status: 'in_progress' as const },
    ]
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(
        fauxToolCall('agim_todo_write', { items: itemsA }, { id: 'todo-a' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('agim_todo_write', { items: itemsB }, { id: 'todo-b' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('ok'),
    ])
    const tool: ToolDef = {
      name: 'agim_todo_write',
      description: 'todo',
      parameters: {
        type: 'object',
        properties: { items: { type: 'array' } },
        required: ['items'],
      },
    }
    const steps: Array<{ id: string; status: string; todoItems?: unknown }> = []
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-todo-plan-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => ({ text: '1. ▶ one\n2. ☐ two', isError: false }),
      }),
    })
    await collect(adapter.sendPrompt('todo-plan-step', 'plan', undefined, {
      onToolActivity: (step) => {
        steps.push({ id: step.id, status: step.status, todoItems: step.todoItems })
      },
    }))
    expect(steps.every((s) => s.id === 'agim-plan-checklist')).toBe(true)
    expect(steps.filter((s) => s.status === 'running')).toHaveLength(2)
    expect(steps.filter((s) => s.status === 'success')).toHaveLength(2)
    expect(steps.at(-1)?.todoItems).toEqual(itemsB)
  })

  it('emits onToolActivity denied when approval gate blocks', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(fauxToolCall('agim_exec', { cmd: 'ls' }, { id: 'deny-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('stopped'),
    ])
    const tool: ToolDef = {
      name: 'agim_exec',
      description: 'exec',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    }
    const steps: Array<{ id: string; status: string }> = []
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-activity-deny-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => ({ text: 'ran', isError: false }),
      }),
      resolveApprovalGate: () => async () => 'deny',
    })
    await collect(adapter.sendPrompt('activity-deny', 'run', undefined, {
      onToolActivity: (step) => {
        steps.push({ id: step.id, status: step.status })
      },
    }))
    expect(steps).toEqual([{ id: 'deny-1', status: 'denied' }])
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

  it('blocks oversize single-message tool batches at tool_call preflight', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage(
        [1, 2, 3, 4, 5].map((n) => fauxToolCall('step', { n }, { id: `solo${n}` })),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('should not run'),
    ])
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
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-preflight-budget-')),
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
    const out = await collect(adapter.sendPrompt('preflight-budget', 'one fat batch'))
    // message_end may abort the whole oversize batch (0 dispatches), or
    // tool_call preflight may admit only the first N. Either way we must
    // never execute past the budget.
    expect(dispatchCount).toBeLessThanOrEqual(3)
    expect(out).toContain('工具调用预算 3')
  })

  it('flags narrated tool calls that never emitted a real toolCall', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage('我现在调用 agim_write_file 把结果写进去：\n```python\nprint(1)\n```'),
    ])
    const tool: ToolDef = {
      name: 'agim_write_file',
      description: 'write',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    let outcome: string | undefined
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-hallucination-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => ({ text: 'should not run', isError: false }),
      }),
    })
    const out = await collect(adapter.sendPrompt('hallucination', 'write the file', undefined, {
      onOutcome: (value) => { outcome = value.error },
    }))
    expect(out).toContain('口述了工具调用')
    expect(outcome).toBe('hallucinated_tools')
  })

  it('marks length-truncated replies as partial', async () => {
    const reg = faux()
    reg.setResponses([
      fauxAssistantMessage('partial answer that got cut', { stopReason: 'length' }),
    ])
    let outcome: string | undefined
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-length-')),
      resolveModel: async () => bindingFromFaux(reg),
    })
    const out = await collect(adapter.sendPrompt('length', 'write a long essay', undefined, {
      onOutcome: (value) => { outcome = value.error ?? value.status },
    }))
    expect(out).toContain('输出长度上限被截断')
    expect(outcome).toBe('length')
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

  it('soft-steers then hard-stops repeated schema-invalid calls', async () => {
    const reg = faux()
    reg.setResponses(Array.from({ length: 10 }, (_v, i) =>
      fauxAssistantMessage(fauxToolCall('needs_arg', {}, { id: `invalid${i}` }), { stopReason: 'toolUse' })))
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
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-invalid-stuck-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => ({ text: 'unexpected', isError: false }),
      }),
      maxIterations: 10,
      maxToolCalls: 10,
    })

    const out = await collect(adapter.sendPrompt('invalid-stuck', 'repeat invalid'))
    // 3 identical failures → soft steer; next 3 → hard stop.
    expect(reg.state.callCount).toBe(6)
    expect(out).toContain('死循环')
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

  it('soft-steers then hard-stops a stuck loop (same tool + args erroring)', async () => {
    const reg = faux()
    let sawSteer = false
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
    // 3 identical failures → soft steer (continue); next 3 → hard stop.
    reg.setResponses([
      ...Array.from({ length: 3 }, (_v, i) =>
        fauxAssistantMessage(
          fauxToolCall('flaky', i % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 }, { id: `s${i}` }),
          { stopReason: 'toolUse' },
        ),
      ),
      (ctx) => {
        const user = [...ctx.messages].reverse().find((message) => message.role === 'user')
        const text = typeof user?.content === 'string'
          ? user.content
          : (user?.content ?? []).map((block) => block.type === 'text' ? block.text : '').join('')
        if (text.includes('repeated failure')) sawSteer = true
        return fauxAssistantMessage(
          fauxToolCall('flaky', { a: 1, b: 2 }, { id: 's3' }),
          { stopReason: 'toolUse' },
        )
      },
      ...Array.from({ length: 2 }, (_v, i) =>
        fauxAssistantMessage(
          fauxToolCall('flaky', { a: 1, b: 2 }, { id: `s${i + 4}` }),
          { stopReason: 'toolUse' },
        ),
      ),
      fauxAssistantMessage('unreachable after hard stop'),
    ])
    let outcome: import('../../../core/types.js').AgentTurnOutcome | undefined
    const out = await collect(adapter.sendPrompt('s7', 'do the flaky thing', undefined, {
      onOutcome: (value) => { outcome = value },
    }))
    expect(sawSteer).toBe(true)
    expect(calls).toBe(6) // soft-steer window + hard-stop window
    expect(out).toContain('死循环')
    expect(out).toContain('失败原因汇总')
    expect(out).toContain('`flaky`')
    expect(out).toMatch(/upstream 503|失败/)
    expect(outcome?.status).toBe('partial')
    expect(outcome?.stopReason).toBe('stuck_loop')
    expect(outcome?.toolCalls).toBe(6)
    expect((outcome?.modelTurns ?? 0)).toBeGreaterThanOrEqual(2)
  })

  it('soft-steers then hard-stops a cross-tool semantic stuck loop', async () => {
    const shared = 'aapl Q3 earnings call transcript'
    const reg = faux()
    const batch = (names: string[], offset: number) => fauxAssistantMessage(
      names.map((name, i) => fauxToolCall(name, { query: shared }, { id: `${name}${offset + i}` })),
      { stopReason: 'toolUse' },
    )
    let calls = 0
    let sawSteer = false
    const tools: ToolDef[] = ['search_a', 'search_b', 'search_c', 'search_d', 'search_e', 'search_f'].map((name) => ({
      name,
      description: name,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }))
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-semantic-stuck-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools,
        dispatch: async (call) => {
          calls += 1
          return { text: `0 results for ${String(call.arguments.query ?? '')}`, isError: true }
        },
      }),
      maxIterations: 20,
      maxToolCalls: 20,
    })
    // Soft steer keeps the turn alive; the next identical-intent batch hard-stops.
    // Ephemeral steer must appear on the second provider call (never as durable JSONL).
    reg.setResponses([
      batch(['search_a', 'search_b', 'search_c'], 0),
      (ctx) => {
        const user = [...ctx.messages].reverse().find((message) => message.role === 'user')
        const text = typeof user?.content === 'string'
          ? user.content
          : (user?.content ?? []).map((block) => block.type === 'text' ? block.text : '').join('')
        if (text.includes('semantic stuck')) sawSteer = true
        return batch(['search_d', 'search_e', 'search_f'], 10)
      },
      fauxAssistantMessage('unreachable after hard stop'),
    ])
    const out = await collect(adapter.sendPrompt('semantic-stuck', 'find the earnings call'))
    expect(sawSteer).toBe(true)
    expect(calls).toBe(6)
    expect(out).toContain('死循环')
  })

  it('does not treat successful same-URL exploration as a semantic stuck loop', async () => {
    const sharedUrl = 'http://localhost:8000/api/v1/composite/fund-overlap?codes=012729,160424'
    const reg = faux()
    const batch = (offset: number) => fauxAssistantMessage(
      [
        fauxToolCall('agim_exec', { command: `curl -sS '${sharedUrl}'` }, { id: `e${offset}` }),
        fauxToolCall('agim_web_fetch', { url: sharedUrl, format: 'raw' }, { id: `f${offset}` }),
        fauxToolCall('agim_exec', { command: `curl -sS '${sharedUrl}' | head` }, { id: `e${offset + 1}` }),
      ],
      { stopReason: 'toolUse' },
    )
    let calls = 0
    const tools: ToolDef[] = [
      {
        name: 'agim_exec',
        description: 'exec',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      {
        name: 'agim_web_fetch',
        description: 'fetch',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            format: { type: 'string' },
          },
          required: ['url'],
        },
      },
    ]
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-semantic-ok-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools,
        dispatch: async () => {
          calls += 1
          return { text: '{"ok":true}', isError: false }
        },
      }),
      maxIterations: 10,
      maxToolCalls: 20,
    })
    reg.setResponses([
      batch(0),
      batch(10),
      fauxAssistantMessage('done exploring the endpoint'),
    ])
    const out = await collect(adapter.sendPrompt('semantic-ok', 'probe fund-overlap'))
    expect(calls).toBe(6)
    expect(out).toContain('done exploring the endpoint')
    expect(out).not.toContain('死循环')
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
    let outcome: import('../../../core/types.js').AgentTurnOutcome | undefined
    const adapter = new NativeAgentAdapter({
      sessionsRoot,
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({
        tools: [tool],
        dispatch: async () => ({ text: 'tool result', isError: false }),
      }),
      streamOptions: { cacheRetention: 'short' },
    })
    await collect(adapter.sendPrompt('usage-all-turns', 'run', undefined, {
      onUsage: (usage) => { reported = usage },
      onOutcome: (value) => { outcome = value },
    }))

    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((item) => item.id === 'usage-all-turns')
    if (!meta) throw new Error('missing usage session')
    const entries = await (await repo.open(meta)).getEntries()
    const usages = entries.flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'assistant'
        ? [entry.message.usage]
        : [])
    expect(usages).toHaveLength(2)
    expect(reported?.tokensInput).toBe(usages.reduce(
      (sum, usage) => sum + usage.input + usage.cacheRead + usage.cacheWrite,
      0,
    ))
    expect(reported?.tokensOutput).toBe(usages.reduce((sum, usage) => sum + usage.output, 0))
    expect(outcome?.status).toBe('success')
    expect(outcome?.modelTurns).toBe(2)
    expect(outcome?.toolCalls).toBe(1)
    expect(outcome?.usage?.tokensInput).toBe(reported?.tokensInput)
    expect(outcome?.usage?.tokensOutput).toBe(reported?.tokensOutput)
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
        { name: 'deepseek-agim', providerType: 'openai-compat', model: 'deepseek-v4-pro' },
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
        { name: 'deepseek-agim', providerType: 'openai-compat', model: 'deepseek-v4-pro' },
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
      fauxAssistantMessage(fauxToolCall('agim_exec', { command: 'npm test' }, { id: 'test1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('测试通过，已完成。'),
    ])
    const tool: ToolDef = {
      name: 'agim_exec',
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

  it('delivers mid-turn report text when the last hop is only a short closure', async () => {
    const reg = faux()
    const report = [
      '## 盘点结果',
      '',
      '- 模块 A：正常',
      '- 模块 B：有风险',
      '- 模块 C：待跟进',
      '',
      '建议下一步：先处理模块 B。',
      '补充细节：'.padEnd(120, '详'),
    ].join('\n')
    const todo = fauxToolCall('agim_todo_write', { items: [{ id: '1', status: 'done' }] }, { id: 'todo1' })
    reg.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: report }, todo] as never,
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('盘点完成。有任何需要深挖的方向随时说。'),
    ])
    const tool: ToolDef = {
      name: 'agim_todo_write',
      description: 'todo',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    const dispatch: ToolDispatcher = async () => ({ text: 'ok', isError: false })
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-midturn-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt('midturn-report', '请盘点并更新 todo'))
    expect(out).toContain('盘点结果')
    expect(out).toContain('模块 B：有风险')
    expect(out).toContain('盘点完成')
  })

  it('rescues mid-turn report when the last hop is empty after tools', async () => {
    const reg = faux()
    const report = `完整盘点正文：${'条目。'.repeat(40)}`
    const todo = fauxToolCall('agim_todo_write', { items: [] }, { id: 'todo2' })
    reg.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: report }, todo] as never,
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(''),
    ])
    const tool: ToolDef = {
      name: 'agim_todo_write',
      description: 'todo',
      parameters: { type: 'object', properties: {}, required: [] },
    }
    const dispatch: ToolDispatcher = async () => ({ text: 'ok', isError: false })
    const adapter = new NativeAgentAdapter({
      sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-midturn-empty-')),
      resolveModel: async () => bindingFromFaux(reg),
      resolveTools: () => ({ tools: [tool], dispatch }),
    })
    const out = await collect(adapter.sendPrompt('midturn-empty', '盘点'))
    expect(out).toContain('完整盘点正文')
    expect(out).not.toContain('没有生成收尾文字')
  })

  it('does not append tool-failure diagnostics when tools fail but the model still returns text', async () => {
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
    expect(out).toBe('我根据已有信息继续。')
    expect(out).not.toContain('诊断')
    expect(out).not.toContain('flaky_lookup')
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
    let reported: { tokensInput?: number; tokensOutput?: number } | undefined
    let outcome: import('../../../core/types.js').AgentTurnOutcome | undefined
    const activity: import('../../../core/types.js').ToolActivityStep[] = []
    expect(await collect(adapter.sendPrompt('cmp', 'q2', undefined, {
      onUsage: (usage) => { reported = usage },
      onOutcome: (value) => { outcome = value },
      onToolActivity: (step) => { activity.push(step) },
    }))).toBe('t2')
    // The durable session now carries a compaction entry.
    const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
    const meta = (await repo.list()).find((m) => m.id === 'cmp')
    expect(meta).toBeDefined()
    if (!meta) throw new Error('missing cmp session metadata')
    const entries = await (await repo.open(meta)).getEntries()
    expect(entries.some((e) => e.type === 'compaction')).toBe(true)
    // Compaction has no assistant usage row — estimated tokens still reach onUsage.
    expect((reported?.tokensInput ?? 0) + (reported?.tokensOutput ?? 0)).toBeGreaterThan(0)
    expect((outcome?.auxModelCalls ?? 0)).toBeGreaterThanOrEqual(1)
    expect(outcome?.contextBudget?.compactSuccess).toBeGreaterThanOrEqual(1)
    expect((outcome?.contextBudget?.tokensBefore ?? 0)).toBeGreaterThan(0)
    // Chat accordion sees running → success for the compaction status step.
    const compactSteps = activity.filter((s) => s.kind === 'status' && s.label === 'Compacting context')
    expect(compactSteps.map((s) => s.status)).toEqual(['running', 'success'])
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

  it('compacts mid-turn when tools inflate past the reserve line', async () => {
    // keepRecent small enough to cut; raise tool-result cap so the dump survives.
    process.env.AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS = '500'
    process.env.AGIM_CTX_COMPACT_RESERVE_TOKENS = '8000'
    process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS = '500000'
    try {
      const reg = registerFauxProvider({ models: [{ id: 'mid', contextWindow: 32_000 }] })
      regs.push(reg)
      reg.setResponses([
        fauxAssistantMessage(fauxToolCall('dump', {}, { id: 'd1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('mid-turn history summary'),
        fauxAssistantMessage('done after compact'),
      ])
      const tool: ToolDef = {
        name: 'dump',
        description: 'dump',
        parameters: { type: 'object', properties: {}, required: [] },
      }
      const dispatch: ToolDispatcher = async () => ({
        // Larger than window-reserve even after emergency keep≤2.
        text: 'PAYLOAD:'.padEnd(200_000, 'x'),
        isError: false,
      })
      const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-ad-'))
      const adapter = new NativeAgentAdapter({
        sessionsRoot,
        resolveModel: async () => bindingFromFaux(reg),
        resolveTools: () => ({ tools: [tool], dispatch }),
      })
      const activity: import('../../../core/types.js').ToolActivityStep[] = []
      let outcome: import('../../../core/types.js').AgentTurnOutcome | undefined
      expect(await collect(adapter.sendPrompt('mid-cmp', 'dump lots', undefined, {
        onToolActivity: (step) => { activity.push(step) },
        onOutcome: (value) => { outcome = value },
      }))).toBe('done after compact')
      const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot })
      const meta = (await repo.list()).find((m) => m.id === 'mid-cmp')
      if (!meta) throw new Error('missing mid-cmp session')
      const entries = await (await repo.open(meta)).getEntries()
      expect(entries.some((e) => e.type === 'compaction')).toBe(true)
      const compactSteps = activity.filter((s) => s.kind === 'status' && s.label === 'Compacting context')
      expect(compactSteps.some((s) => s.status === 'running')).toBe(true)
      expect(compactSteps.some((s) => s.status === 'success')).toBe(true)
      expect(compactSteps.some((s) => s.preview?.includes('mid-turn'))).toBe(true)
      expect((outcome?.auxModelCalls ?? 0)).toBeGreaterThanOrEqual(1)
      expect(outcome?.contextBudget?.compactSuccess).toBeGreaterThanOrEqual(1)
      expect((outcome?.contextBudget?.tokensBefore ?? 0)).toBeGreaterThan(0)
    } finally {
      delete process.env.AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS
      delete process.env.AGIM_CTX_COMPACT_RESERVE_TOKENS
      delete process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS
    }
  })

  it('continues the turn when mid-turn compaction summarization fails', async () => {
    process.env.AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS = '500'
    process.env.AGIM_CTX_COMPACT_RESERVE_TOKENS = '8000'
    process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS = '500000'
    try {
      const reg = registerFauxProvider({ models: [{ id: 'mid', contextWindow: 32_000 }] })
      regs.push(reg)
      reg.setResponses([
        fauxAssistantMessage(fauxToolCall('dump', {}, { id: 'd2' }), { stopReason: 'toolUse' }),
        // compact() starves here → error activity; turn must still settle.
      ])
      const tool: ToolDef = {
        name: 'dump',
        description: 'dump',
        parameters: { type: 'object', properties: {}, required: [] },
      }
      const dispatch: ToolDispatcher = async () => ({
        text: 'PAYLOAD:'.padEnd(200_000, 'x'),
        isError: false,
      })
      const adapter = new NativeAgentAdapter({
        sessionsRoot: mkdtempSync(join(tmpdir(), 'pi-ad-')),
        resolveModel: async () => bindingFromFaux(reg),
        resolveTools: () => ({ tools: [tool], dispatch }),
      })
      const activity: import('../../../core/types.js').ToolActivityStep[] = []
      let outcome: import('../../../core/types.js').AgentTurnOutcome | undefined
      const out = await collect(adapter.sendPrompt('mid-fail', 'dump', undefined, {
        onToolActivity: (step) => { activity.push(step) },
        onOutcome: (value) => { outcome = value },
      }))
      expect(typeof out).toBe('string')
      const compactSteps = activity.filter((s) => s.kind === 'status' && s.label === 'Compacting context')
      expect(compactSteps.some((s) => s.status === 'running')).toBe(true)
      expect(compactSteps.some((s) => s.status === 'error' || s.status === 'success')).toBe(true)
      expect((outcome?.contextBudget?.compactFail ?? 0)).toBeGreaterThanOrEqual(1)
    } finally {
      delete process.env.AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS
      delete process.env.AGIM_CTX_COMPACT_RESERVE_TOKENS
      delete process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS
    }
  })
})
