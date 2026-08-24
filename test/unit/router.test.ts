// Unit tests for message router

import { describe, it, expect, beforeEach, vi } from 'bun:test'
import { parseMessage, prepareSubtaskAgentCallOptions, routeMessage, type RouteContext } from '../../src/core/router'
import { registry } from '../../src/core/registry'
import { workspaceRegistry } from '../../src/core/workspace'
import { sessionManager } from '../../src/core/session'
import { __resetLiveConfigForTest, setLiveConfig } from '../../src/core/live-config'
import type { AgentAdapter, Config } from '../../src/core/types'
import type { Logger } from 'pino'

// Mock agent for testing
async function* mockGenerator(): AsyncGenerator<string> {
  yield 'test response'
}

const mockAgent: AgentAdapter = {
  name: 'test-agent',
  aliases: ['ta', 'testagent'],
  isAvailable: vi.fn().mockResolvedValue(true),
  sendPrompt: vi.fn().mockImplementation(() => mockGenerator()),
}

// No-op logger for tests — satisfies the structural shape pino exposes
const noopLogger = (() => {
  const noop = (..._args: unknown[]) => {}
  const stub: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    level: 'info', bindings: () => ({}),
  }
  stub.child = () => stub
  return stub as unknown as Logger
})()

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    threadId: 'thread-1',
    channelId: 'channel-1',
    platform: 'wechat',
    defaultAgent: 'test-agent',
    traceId: 'trace-test',
    logger: noopLogger,
    userId: 'user-1',
    ...overrides,
  }
}

describe('parseMessage', () => {
  beforeEach(() => {
    // Clear registry before each test
    vi.clearAllMocks()
  })

  describe('default agent routing', () => {
    it('should route plain text to default agent', () => {
      const result = parseMessage('hello world')
      expect(result).toEqual({ type: 'default', prompt: 'hello world' })
    })

    it('should handle empty string as default with empty prompt', () => {
      const result = parseMessage('')
      expect(result).toEqual({ type: 'default', prompt: '' })
    })

    it('should trim whitespace from input', () => {
      const result = parseMessage('  hello world  ')
      expect(result).toEqual({ type: 'default', prompt: 'hello world' })
    })
  })

  describe('built-in commands', () => {
    it('should parse bare /status as a service-control intent', () => {
      const result = parseMessage('/status')
      expect(result).toEqual({ type: 'service', action: 'status', args: '' })
    })

    it('should parse /help command (no args)', () => {
      expect(parseMessage('/help')).toEqual({ type: 'command', command: 'help', args: '' })
    })

    it('should pass /help args through (lang + topic)', () => {
      expect(parseMessage('/help en')).toEqual({ type: 'command', command: 'help', args: 'en' })
      expect(parseMessage('/help remind')).toEqual({ type: 'command', command: 'help', args: 'remind' })
      expect(parseMessage('/help en cron')).toEqual({ type: 'command', command: 'help', args: 'en cron' })
    })

    it('should accept /? as alias of /help', () => {
      expect(parseMessage('/?')).toEqual({ type: 'command', command: 'help', args: '' })
    })

    it('should pass /start args through (lang)', () => {
      expect(parseMessage('/start')).toEqual({ type: 'command', command: 'start', args: '' })
      expect(parseMessage('/start en')).toEqual({ type: 'command', command: 'start', args: 'en' })
    })

    it('should parse /agents command', () => {
      const result = parseMessage('/agents')
      expect(result).toEqual({ type: 'command', command: 'agents' })
    })

    // Batch 2 (#2) — stopAgent triggers
    it('parses /abort as stopAgent', () => {
      expect(parseMessage('/abort')).toEqual({ type: 'stopAgent' })
    })
    it.each([
      'stop', 'Stop', 'STOP',
      '停止', '停', '中止', '取消运行',
      'esc', 'ESC', 'escape',
    ])('parses bare %s as stopAgent', (cmd) => {
      expect(parseMessage(cmd)).toEqual({ type: 'stopAgent' })
    })
    it('does NOT match "stop the music" — partial match falls through', () => {
      const r = parseMessage('stop the music')
      expect(r).toEqual({ type: 'default', prompt: 'stop the music' })
    })
    it('/stop keeps its service-stop meaning (admin-gated)', () => {
      expect(parseMessage('/stop')).toEqual({ type: 'service', action: 'stop', args: '' })
    })

    describe('/focus + /loop', () => {
      it('parses /focus and aliases', () => {
        expect(parseMessage('/focus')).toEqual({ type: 'focus', args: '' })
        expect(parseMessage('/focus set foo')).toEqual({ type: 'focus', args: 'set foo' })
        expect(parseMessage('/f on')).toEqual({ type: 'focus', args: 'on' })
        expect(parseMessage('/聚焦 off')).toEqual({ type: 'focus', args: 'off' })
      })
      it('parses /loop', () => {
        expect(parseMessage('/loop')).toEqual({ type: 'loop', args: '' })
        expect(parseMessage('/loop ship it')).toEqual({ type: 'loop', args: 'ship it' })
        expect(parseMessage('/loop status')).toEqual({ type: 'loop', args: 'status' })
      })
      it('parses /loop after leading file/image attachment markers (Portal upload)', () => {
        const fileMarker = '[文件附件：/home/u/.agim/media/web/t/report.md (report.md, 12 B)]'
        const imageMarker = '[图片附件：/home/u/.agim/media/web/t/a.png]'
        expect(parseMessage(`${fileMarker}\n/loop 根据报告优化`)).toEqual({
          type: 'loop',
          args: `${fileMarker}\n根据报告优化`,
        })
        expect(parseMessage(`${imageMarker}\n${fileMarker}\n/loop ship`)).toEqual({
          type: 'loop',
          args: `${imageMarker}\n${fileMarker}\nship`,
        })
        expect(parseMessage(`${fileMarker}\n/loop`)).toEqual({
          type: 'loop',
          args: fileMarker,
        })
      })
      it('parses /loop after leading workspace/skill mention chips', () => {
        expect(parseMessage('[工作区文件：docs/a.md] /loop review')).toEqual({
          type: 'loop',
          args: '[工作区文件：docs/a.md]\nreview',
        })
        expect(parseMessage('[技能：deploy]\n/status')).toEqual({
          type: 'service',
          action: 'status',
          args: '[技能：deploy]',
        })
      })
      it('keeps markers in default prompt when no slash follows', () => {
        const marker = '[文件附件：/tmp/x.md (x.md, 1 B)]'
        expect(parseMessage(`${marker}\nplease summarize`)).toEqual({
          type: 'default',
          prompt: `${marker}\nplease summarize`,
        })
      })
      it('treats retired goal slash commands as unknown', () => {
        for (const input of [
          '/goal',
          '/goal set foo',
          '/g set foo',
          '/目标 set foo',
          '/long_task ship v1.2',
          '/longtask ship v1.2',
          '/long-task ship v1.2',
          '/complete_goal',
          '/completegoal',
          '/complete-goal',
        ]) {
          const result = parseMessage(input)
          expect(result.type).toBe('error')
          if (result.type === 'error') {
            expect(result.error).toContain('未知命令')
          }
        }
      })
      it('parses /heartbeat as type: heartbeat (regression — was undefined)', () => {
        expect(parseMessage('/heartbeat')).toEqual({ type: 'heartbeat', args: '' })
        expect(parseMessage('/heartbeat status')).toEqual({ type: 'heartbeat', args: 'status' })
      })
    })

    // Batch 2 (#5) — /btw bypass
    it('parses /btw with prompt', () => {
      expect(parseMessage('/btw quick question')).toEqual({ type: 'btw', prompt: 'quick question' })
    })
    it('parses bare /btw with empty prompt (handler will reject)', () => {
      expect(parseMessage('/btw')).toEqual({ type: 'btw', prompt: '' })
    })

    // Batch 3 (#6) — @multi-agent routing
    describe('@<agent> routing', () => {
      beforeEach(() => {
        // parseMessage's describe block doesn't pre-register the test-agent
        // (only the routeMessage describe further down does). Register
        // explicitly so registry.findAgent() resolves the alias.
        registry.registerAgent(mockAgent)
      })

      it('parses @<registered-agent> as type agent', () => {
        const r = parseMessage('@test-agent hello world')
        expect(r).toEqual({ type: 'agent', agent: 'test-agent', prompt: 'hello world' })
      })
      it('@<alias> resolves to the underlying agent name', () => {
        const r = parseMessage('@ta hello')
        expect(r).toEqual({ type: 'agent', agent: 'test-agent', prompt: 'hello' })
      })
      it('@<unknown> falls through to default (agent sees the @ verbatim)', () => {
        const r = parseMessage('@stranger hi')
        expect(r).toEqual({ type: 'default', prompt: '@stranger hi' })
      })
      it('@<agent> with no prompt body is allowed (empty prompt)', () => {
        const r = parseMessage('@test-agent')
        expect(r).toEqual({ type: 'agent', agent: 'test-agent', prompt: '' })
      })
      it('@<agent> in the middle of a sentence does NOT route', () => {
        const r = parseMessage('hey @test-agent please')
        expect(r).toEqual({ type: 'default', prompt: 'hey @test-agent please' })
      })
    })

    it('should parse /status as a service-control intent', () => {
      // /status migrated from a hardcoded builtin to a real service-status
      // handler in commands/service.ts. Args are forwarded (currently unused).
      const result = parseMessage('/status extra text')
      expect(result).toEqual({ type: 'service', action: 'status', args: 'extra text' })
    })

    it('should parse /restart as a service-control intent', () => {
      const result = parseMessage('/restart')
      expect(result).toEqual({ type: 'service', action: 'restart', args: '' })
    })

    it('should parse /stop as a service-control intent', () => {
      const result = parseMessage('/stop')
      expect(result).toEqual({ type: 'service', action: 'stop', args: '' })
    })
  })

  describe('agent switching', () => {
    it('should route to agent by alias when registered', () => {
      // Register mock agent
      registry.registerAgent(mockAgent)

      const result = parseMessage('/ta explain this code')
      expect(result).toEqual({
        type: 'agent',
        agent: 'test-agent',
        prompt: 'explain this code',
      })
    })

    it('should route to agent by full name', () => {
      registry.registerAgent(mockAgent)

      const result = parseMessage('/test-agent hello')
      expect(result).toEqual({
        type: 'agent',
        agent: 'test-agent',
        prompt: 'hello',
      })
    })

    it('should handle agent command without prompt', () => {
      registry.registerAgent(mockAgent)

      const result = parseMessage('/ta')
      expect(result).toEqual({
        type: 'agent',
        agent: 'test-agent',
        prompt: '',
      })
    })
  })

  describe('agent commands', () => {
    it('should parse /test as agentCommand', () => {
      const result = parseMessage('/test run unit tests')
      expect(result).toEqual({ type: 'agentCommand', command: 'test', prompt: 'run unit tests' })
    })

    it('should parse agent command without prompt', () => {
      const result = parseMessage('/review')
      expect(result).toEqual({ type: 'agentCommand', command: 'review', prompt: '' })
    })

    it('should parse all supported agent commands', () => {
      const commands = ['test', 'review', 'commit', 'push', 'diff', 'shell', 'bug', 'explain']
      for (const cmd of commands) {
        const result = parseMessage(`/${cmd} some args`)
        expect(result).toEqual({ type: 'agentCommand', command: cmd, prompt: 'some args' })
      }
    })

    it('should route to registered agent instead of generic command when name matches', () => {
      // Register an agent named "test"
      const testAgent: AgentAdapter = {
        name: 'test',
        aliases: [],
        isAvailable: vi.fn().mockResolvedValue(true),
        sendPrompt: vi.fn().mockImplementation(() => mockGenerator()),
      }
      registry.registerAgent(testAgent)

      const result = parseMessage('/test something')
      // Registered agent takes priority over generic agentCommand
      expect(result).toEqual({ type: 'agent', agent: 'test', prompt: 'something' })
    })
  })

  describe('error handling', () => {
    it('should return error for unknown command', () => {
      const result = parseMessage('/unknown command')
      expect(result.type).toBe('error')
      if (result.type === 'error') {
        expect(result.error).toBe('未知命令：unknown')
        expect(result.prompt).toBe('/unknown command')
      }
    })

    it('should return error for unregistered agent alias', () => {
      const result = parseMessage('/nonexistent-agent prompt')
      expect(result.type).toBe('error')
      if (result.type === 'error') {
        expect(result.error).toContain('未知命令')
      }
    })

    it('explains when a registered agent alias is disabled by config.agents', () => {
      const disabledAgent: AgentAdapter = {
        name: 'disabled-agent',
        aliases: ['da'],
        isAvailable: vi.fn().mockResolvedValue(true),
        sendPrompt: vi.fn().mockImplementation(() => mockGenerator()),
      }
      registry.registerAgent(disabledAgent)
      setLiveConfig({ agents: ['test-agent'], defaultAgent: 'test-agent' } as Config)
      try {
        const result = parseMessage('/da hello')
        expect(result.type).toBe('error')
        if (result.type === 'error') {
          expect(result.error).toContain('Agent "disabled-agent" 已被停用')
          expect(result.error).toContain('config.agents')
        }
      } finally {
        __resetLiveConfigForTest()
      }
    })
  })

  describe('Phase 2/3 commands', () => {
    it('parses /audit with args', () => {
      const result = parseMessage('/audit agent=opencode days=7')
      expect(result).toEqual({ type: 'audit', args: 'agent=opencode days=7' })
    })

    it('parses /router with args', () => {
      const result = parseMessage('/router explain hello world')
      expect(result).toEqual({ type: 'router', args: 'explain hello world' })
    })

    it('parses /job and /task as aliases', () => {
      expect(parseMessage('/job list')).toEqual({ type: 'job', args: 'list' })
      expect(parseMessage('/task list')).toEqual({ type: 'job', args: 'list' })
    })

    it('parses /tasks shorthand to job list', () => {
      expect(parseMessage('/tasks')).toEqual({ type: 'job', args: 'list' })
    })

    it('parses /check, /cancel, /switch, /collect as job sub-commands', () => {
      expect(parseMessage('/check 5')).toEqual({ type: 'job', args: 'check 5' })
      expect(parseMessage('/cancel 5')).toEqual({ type: 'job', args: 'cancel 5' })
      expect(parseMessage('/switch main')).toEqual({ type: 'job', args: 'switch main' })
      expect(parseMessage('/collect 5')).toEqual({ type: 'job', args: 'collect 5' })
    })

    it('parses /new built-in command', () => {
      expect(parseMessage('/new')).toEqual({ type: 'command', command: 'new' })
    })

    it('parses IM self-register and login commands', () => {
      expect(parseMessage('/register alice password1')).toEqual({
        type: 'command', command: 'register', args: 'alice password1',
      })
      expect(parseMessage('/signup bob password1 AGIM-ABCD-EFGH')).toEqual({
        type: 'command', command: 'register', args: 'bob password1 AGIM-ABCD-EFGH',
      })
      expect(parseMessage('/login alice password1')).toEqual({
        type: 'command', command: 'login', args: 'alice password1',
      })
      expect(parseMessage('/signin alice password1')).toEqual({
        type: 'command', command: 'login', args: 'alice password1',
      })
      expect(parseMessage('/bind ABC123')).toEqual({
        type: 'command', command: 'bind', args: 'ABC123',
      })
    })

    it('parses /workspaces and /ws as aliases', () => {
      expect(parseMessage('/workspaces list')).toEqual({ type: 'workspaces', args: 'list' })
      expect(parseMessage('/ws list')).toEqual({ type: 'workspaces', args: 'list' })
    })

    it('parses /cron as primary and /schedule as legacy alias (P2-F)', () => {
      expect(parseMessage('/cron list')).toEqual({ type: 'cron', args: 'list' })
      expect(parseMessage('/schedule list')).toEqual({ type: 'cron', args: 'list', legacy: true })
    })

    it('parses /cronloop and /cornloop', () => {
      expect(parseMessage('/cronloop')).toEqual({ type: 'cronloop', args: '' })
      expect(parseMessage('/cronloop 每天凌晨2点')).toEqual({ type: 'cronloop', args: '每天凌晨2点' })
      expect(parseMessage('/cornloop')).toEqual({ type: 'cronloop', args: '' })
    })

    it('parses /approval and /auto as aliases', () => {
      expect(parseMessage('/approval')).toEqual({ type: 'approval', args: '' })
      expect(parseMessage('/approval clear')).toEqual({ type: 'approval', args: 'clear' })
      expect(parseMessage('/auto')).toEqual({ type: 'approval', args: '' })
    })
  })
})

describe('routeMessage', () => {
  const ctx = makeCtx()

  beforeEach(() => {
    vi.clearAllMocks()
    registry.registerAgent(mockAgent)
  })

  it('injects a consume-once downvote hint via ephemeralContext', async () => {
    const name = `feedback-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let seenEphemeralContext: string | undefined
    const feedbackAgent: AgentAdapter = {
      name,
      aliases: [],
      handlesAgimSkillsPrompt: true,
      handlesEphemeralContext: true,
      isAvailable: async () => true,
      sendPrompt: (_sessionId, _prompt, _history, opts) => {
        seenEphemeralContext = opts?.ephemeralContext
        return mockGenerator()
      },
    }
    registry.registerAgent(feedbackAgent)
    const threadId = `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const feedbackCtx = makeCtx({ threadId, userId: `user-${threadId}` })
    const {
      setPendingDownvoteHint,
      feedbackThreadKey,
      DOWNVOTE_HINT_TEMPLATE,
      resetPendingDownvoteHints,
    } = await import('../../src/core/message-feedback-hints.js')
    resetPendingDownvoteHints()
    setPendingDownvoteHint(feedbackThreadKey(feedbackCtx.platform, feedbackCtx.channelId, threadId))
    try {
      const result = await routeMessage(
        { type: 'agent', agent: name, prompt: 'follow up' },
        feedbackCtx,
      )
      for await (const _ of result as AsyncGenerator<string>) { /* drain */ }
      expect(seenEphemeralContext).toContain(DOWNVOTE_HINT_TEMPLATE)

      // Second turn must not see the hint again.
      seenEphemeralContext = undefined
      const result2 = await routeMessage(
        { type: 'agent', agent: name, prompt: 'again' },
        feedbackCtx,
      )
      for await (const _ of result2 as AsyncGenerator<string>) { /* drain */ }
      expect(seenEphemeralContext ?? '').not.toContain('rated unhelpful')

      const stored = await sessionManager.getExistingSession(
        feedbackCtx.platform,
        feedbackCtx.channelId,
        feedbackCtx.threadId,
      )
      expect(stored?.messages.some((m) => m.content.includes('rated unhelpful'))).toBe(false)
    } finally {
      resetPendingDownvoteHints()
    }
  })

  it('passes only pre-turn history to a fresh agent call', async () => {
    const name = `history-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let seenHistory: string[] | undefined
    let seenSignal: AbortSignal | undefined
    let seenPrompt: string | undefined
    let seenEphemeralContext: string | undefined
    const historyAgent: AgentAdapter = {
      name,
      aliases: [],
      handlesAgimSkillsPrompt: true,
      handlesEphemeralContext: true,
      isAvailable: async () => true,
      sendPrompt: (_sessionId, prompt, history, opts) => {
        seenHistory = (history ?? []).map((m) => m.content)
        seenSignal = opts?.signal
        seenPrompt = prompt
        seenEphemeralContext = opts?.ephemeralContext
        return mockGenerator()
      },
    }
    registry.registerAgent(historyAgent)
    const threadId = `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    const historyCtx = makeCtx({ threadId, userId: `user-${threadId}`, signal: controller.signal })
    const savedViewer = process.env.AGIM_VIEWER_ENABLED
    process.env.AGIM_VIEWER_ENABLED = '1'
    try {
      const result = await routeMessage(
        { type: 'agent', agent: name, prompt: 'current prompt' },
        historyCtx,
      )
      for await (const _ of result as AsyncGenerator<string>) { /* drain */ }

      expect(seenHistory).toEqual([])
      expect(seenSignal).toBe(controller.signal)
      expect(seenPrompt).toBe('current prompt')
      expect(seenEphemeralContext).toContain('im-summary')
      const stored = await sessionManager.getExistingSession(
        historyCtx.platform,
        historyCtx.channelId,
        historyCtx.threadId,
      )
      expect(stored?.messages.map((m) => m.content)).toEqual(['current prompt', 'test response'])
    } finally {
      if (savedViewer === undefined) delete process.env.AGIM_VIEWER_ENABLED
      else process.env.AGIM_VIEWER_ENABLED = savedViewer
    }
  })

  it('does not persist user or partial assistant text when a turn is aborted', async () => {
    const name = `aborting-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    const abortingAgent: AgentAdapter = {
      name,
      aliases: [],
      isAvailable: async () => true,
      sendPrompt: (_sessionId, _prompt, _history, opts) => (async function* () {
        opts?.onUsage?.({ tokensInput: 10, tokensOutput: 2, costUsd: 0.01 })
        controller.abort()
        opts?.onOutcome?.({ status: 'aborted', providerFailure: false })
        yield 'partial text that must not persist'
      })(),
    }
    registry.registerAgent(abortingAgent)
    const threadId = `abort-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const abortCtx = makeCtx({
      threadId,
      userId: `user-${threadId}`,
      signal: controller.signal,
    })

    const result = await routeMessage(
      { type: 'agent', agent: name, prompt: 'cancel me' },
      abortCtx,
    )
    for await (const _ of result as AsyncGenerator<string>) { /* drain */ }

    const stored = await sessionManager.getExistingSession(
      abortCtx.platform,
      abortCtx.channelId,
      abortCtx.threadId,
    )
    expect(stored?.messages).toEqual([])
    expect(stored?.usage?.tokensInput).toBe(10)
    expect(stored?.usage?.tokensOutput).toBe(2)
    expect(stored?.usage?.costUsd).toBe(0.01)
    expect(abortCtx.agentOutcome?.status).toBe('aborted')
  })

  describe('command routing', () => {
    it('should return service-status message for /status', async () => {
      const result = await routeMessage({ type: 'service', action: 'status', args: '' }, ctx)
      const text = typeof result === 'string' ? result : ''
      expect(text).toContain('Agim')
      expect(text).toContain('agent')
    })

    it('should return help message for /help (zh by default)', async () => {
      const result = await routeMessage({ type: 'command', command: 'help' }, ctx)
      expect(result).toContain('agim 命令速查')
    })

    it('/help en returns the English help', async () => {
      const result = await routeMessage({ type: 'command', command: 'help', args: 'en' }, ctx)
      expect(result).toContain('agim Commands')
    })

    it('/help <topic> returns topic-specific help', async () => {
      const result = await routeMessage({ type: 'command', command: 'help', args: 'cron' }, ctx)
      expect(result).toContain('/cron')
    })

    it('/help <alias> resolves to canonical topic', async () => {
      // tasks/check/cancel/switch/collect → job
      const tasks = await routeMessage({ type: 'command', command: 'help', args: 'tasks' }, ctx)
      expect(tasks).toContain('/job')
      // auto → approval
      const auto = await routeMessage({ type: 'command', command: 'help', args: 'auto' }, ctx)
      expect(auto).toContain('/approval')
      // models → model
      const models = await routeMessage({ type: 'command', command: 'help', args: 'models' }, ctx)
      expect(models).toContain('/model')
      // ws → workspaces
      const ws = await routeMessage({ type: 'command', command: 'help', args: 'ws' }, ctx)
      expect(ws).toContain('/workspaces')
    })

    it('/help reminder delegates to /remind help (alias of remind)', async () => {
      const result = await routeMessage({ type: 'command', command: 'help', args: 'reminder' }, ctx)
      expect(result).toContain('/remind')
    })

    it('/help with unknown topic reports the original input', async () => {
      const result = await routeMessage({ type: 'command', command: 'help', args: 'nonsense-xyz' }, ctx)
      expect(result).toContain('nonsense-xyz')
    })

    it('should return agents list for /agents', async () => {
      const result = await routeMessage({ type: 'command', command: 'agents' }, ctx)
      expect(result).toContain('Available Agents')
    })
  })

  describe('agent routing', () => {
    it('should switch to agent without prompt', async () => {
      const result = await routeMessage(
        { type: 'agent', agent: 'test-agent', prompt: '' },
        ctx
      )
      expect(result).toContain('已切换到 test-agent')
    })

    it('should call agent when prompt provided', async () => {
      const result = await routeMessage(
        { type: 'agent', agent: 'test-agent', prompt: 'hello' },
        ctx
      )
      // Result is an AsyncGenerator when prompt is provided
      expect(typeof result).not.toBe('string')
      // Consume generator
      let text = ''
      for await (const chunk of result as AsyncGenerator<string>) {
        text += chunk
      }
      expect(text).toContain('test response')
    })

    it('should return error when agent not found', async () => {
      const result = await routeMessage(
        { type: 'agent', agent: 'nonexistent', prompt: 'hello' },
        ctx
      )
      expect(result).toContain('找不到')
    })
  })

  describe('default routing', () => {
    it('should call default agent when prompt provided', async () => {
      const result = await routeMessage({ type: 'default', prompt: 'hello' }, ctx)
      // Result is an AsyncGenerator when prompt is provided
      expect(typeof result).not.toBe('string')
      // Consume generator
      let text = ''
      for await (const chunk of result as AsyncGenerator<string>) {
        text += chunk
      }
      expect(text).toContain('test response')
    })

    it('routes active subtask turns into the sub-session only', async () => {
      const threadId = `subtask-default-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const subtaskCtx = makeCtx({ threadId, userId: `user-${threadId}` })
      const jobId = Math.floor(Date.now() + Math.random() * 1000)
      await sessionManager.getOrCreateSession(subtaskCtx.platform, subtaskCtx.channelId, threadId, 'test-agent')
      await sessionManager.updateSubtask(subtaskCtx.platform, subtaskCtx.channelId, threadId, jobId, {
        agent: 'test-agent',
        prompt: 'parent job',
        status: 'running',
        createdAt: new Date(),
      })
      await sessionManager.setActiveSubtask(subtaskCtx.platform, subtaskCtx.channelId, threadId, jobId)

      const result = await routeMessage({ type: 'default', prompt: 'continue subtask' }, subtaskCtx)
      let text = ''
      for await (const chunk of result as AsyncGenerator<string>) {
        text += chunk
      }

      expect(text).toContain('test response')
      const parent = await sessionManager.getExistingSession(subtaskCtx.platform, subtaskCtx.channelId, threadId)
      const sub = await sessionManager.getExistingSession(subtaskCtx.platform, subtaskCtx.channelId, `${threadId}:sub:${jobId}`)
      expect(parent?.messages.map((m) => m.content)).toEqual([])
      expect(sub?.messages.map((m) => m.content)).toEqual(['continue subtask', 'test response'])
    })

    it('should fall through to intent-classified agent even when default not configured', async () => {
      // With Phase 2 intent routing the default-agent name only matters as a
      // fallback when classifyIntent throws. As long as any agent is
      // registered, the router returns an AsyncGenerator pointing at the
      // chosen agent (which agent depends on PROFILES/circuit state and is
      // not asserted here — that is intent.test.ts's job).
      const result = await routeMessage(
        { type: 'default', prompt: 'hello' },
        makeCtx({ threadId: 'thread-no-default', defaultAgent: 'nonexistent', userId: 'user-no-default' })
      )
      expect(typeof result).not.toBe('string')
      // Drain the generator without asserting the body — different test
      // ordering may register additional stub agents.
      for await (const _ of result as AsyncGenerator<string>) { /* drain */ }
    })
  })

  describe('subtask agent session options', () => {
    it('passes antigravity conversation id into A2A subtask calls', async () => {
      const callOptions = await prepareSubtaskAgentCallOptions(
        'antigravity',
        makeCtx(),
        'thread-1:sub:42',
        {
          antigravitySessionId: 'agy-conv-1',
        },
      )

      expect(callOptions).toEqual({
        storageThreadId: 'thread-1:sub:42',
        agentSessionId: 'agy-conv-1',
        agentSessionResume: true,
      })
    })
  })

  describe('error routing', () => {
    it('should return friendly error message', async () => {
      const result = await routeMessage(
        { type: 'error', prompt: '/bad', error: '未知命令：bad' },
        ctx
      )
      expect(result).toContain('未知命令')
      expect(result).toContain('/help')
    })
  })

  describe('workspace whitelist enforcement', () => {
    it('blocks /<agent> when the resolved workspace excludes the agent', async () => {
      // Register a named workspace that whitelists ONLY 'opencode' for alice
      workspaceRegistry.add({
        id: 'ws-test-explicit',
        name: 'Test Explicit',
        agents: ['opencode'],
        members: ['alice-explicit'],
      })

      const result = await routeMessage(
        { type: 'agent', agent: 'test-agent', prompt: 'hi' },
        makeCtx({ userId: 'alice-explicit', threadId: 'ws-thread-explicit' })
      )
      expect(typeof result).toBe('string')
      expect(result).toContain('不在你的工作区可用列表里')
    })

    it('blocks default routing when the resolved workspace excludes the picked agent', async () => {
      workspaceRegistry.add({
        id: 'ws-test-default',
        name: 'Test Default',
        agents: ['nothing-registered'],
        members: ['bob-default'],
      })

      const result = await routeMessage(
        { type: 'default', prompt: 'hi' },
        makeCtx({ userId: 'bob-default', threadId: 'ws-thread-default' })
      )
      expect(typeof result).toBe('string')
      // Either rate-limit or whitelist message — both indicate the request
      // didn't reach the agent.
      expect(result).toMatch(/不在你的工作区|过于频繁|未配置/)
    })
  })

  describe('agent command routing', () => {
    it('should forward agent command to existing session agent', async () => {
      const result = await routeMessage(
        { type: 'agentCommand', command: 'test', prompt: 'run unit tests' },
        ctx
      )
      // Result is an AsyncGenerator
      expect(typeof result).not.toBe('string')
      let text = ''
      for await (const chunk of result as AsyncGenerator<string>) {
        text += chunk
      }
      // Should contain the forwarded command /test run unit tests
      expect(text).toContain('test response')
    })

    it('should return error when no agent found for agentCommand', async () => {
      const result = await routeMessage(
        { type: 'agentCommand', command: 'test', prompt: '' },
        makeCtx({ threadId: 'thread-no-agent', defaultAgent: 'nonexistent' })
      )
      expect(result).toContain('找不到')
    })

    it('should forward agent command without prompt', async () => {
      const result = await routeMessage(
        { type: 'agentCommand', command: 'review', prompt: '' },
        ctx
      )
      expect(typeof result).not.toBe('string')
      let text = ''
      for await (const chunk of result as AsyncGenerator<string>) {
        text += chunk
      }
      expect(text).toContain('test response')
    })

    it('routes agent commands to the active subtask session', async () => {
      const threadId = `subtask-command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const subtaskCtx = makeCtx({ threadId, userId: `user-${threadId}` })
      const jobId = Math.floor(Date.now() + Math.random() * 1000)
      await sessionManager.getOrCreateSession(subtaskCtx.platform, subtaskCtx.channelId, threadId, 'test-agent')
      await sessionManager.updateSubtask(subtaskCtx.platform, subtaskCtx.channelId, threadId, jobId, {
        agent: 'test-agent',
        prompt: 'parent job',
        status: 'running',
        createdAt: new Date(),
      })
      await sessionManager.setActiveSubtask(subtaskCtx.platform, subtaskCtx.channelId, threadId, jobId)

      const result = await routeMessage(
        { type: 'agentCommand', command: 'review', prompt: 'the diff' },
        subtaskCtx,
      )
      let text = ''
      for await (const chunk of result as AsyncGenerator<string>) {
        text += chunk
      }

      expect(text).toContain('test response')
      const parent = await sessionManager.getExistingSession(subtaskCtx.platform, subtaskCtx.channelId, threadId)
      const sub = await sessionManager.getExistingSession(subtaskCtx.platform, subtaskCtx.channelId, `${threadId}:sub:${jobId}`)
      expect(parent?.messages.map((m) => m.content)).toEqual([])
      expect(sub?.messages.map((m) => m.content)).toEqual(['/review the diff', 'test response'])
    })
  })
})
