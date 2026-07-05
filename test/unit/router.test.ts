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

    // v1.2.102 — /goal + /long_task + /complete_goal parsing
    describe('/goal + /long_task + /complete_goal aliases', () => {
      it('parses /goal as type: goal', () => {
        expect(parseMessage('/goal')).toEqual({ type: 'goal', args: '' })
        expect(parseMessage('/goal set foo')).toEqual({ type: 'goal', args: 'set foo' })
        expect(parseMessage('/goal list')).toEqual({ type: 'goal', args: 'list' })
      })
      it('parses /long_task as goal-set shortcut', () => {
        expect(parseMessage('/long_task ship v1.2')).toEqual({ type: 'goal', args: 'set ship v1.2' })
        expect(parseMessage('/longtask ship v1.2')).toEqual({ type: 'goal', args: 'set ship v1.2' })
        expect(parseMessage('/long-task ship v1.2')).toEqual({ type: 'goal', args: 'set ship v1.2' })
      })
      it('parses bare /long_task as help (empty args reach goal handler)', () => {
        expect(parseMessage('/long_task')).toEqual({ type: 'goal', args: '' })
      })
      it('parses /complete_goal as goal-complete shortcut', () => {
        expect(parseMessage('/complete_goal')).toEqual({ type: 'goal', args: 'complete' })
        expect(parseMessage('/completegoal')).toEqual({ type: 'goal', args: 'complete' })
        expect(parseMessage('/complete-goal')).toEqual({ type: 'goal', args: 'complete' })
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
        expect(result.error).toBe('Unknown command: unknown')
        expect(result.prompt).toBe('/unknown command')
      }
    })

    it('should return error for unregistered agent alias', () => {
      const result = parseMessage('/nonexistent-agent prompt')
      expect(result.type).toBe('error')
      if (result.type === 'error') {
        expect(result.error).toContain('Unknown command')
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
          expect(result.error).toContain('Agent "disabled-agent" is disabled')
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

    it('parses /workspaces and /ws as aliases', () => {
      expect(parseMessage('/workspaces list')).toEqual({ type: 'workspaces', args: 'list' })
      expect(parseMessage('/ws list')).toEqual({ type: 'workspaces', args: 'list' })
    })

    it('parses /cron as primary and /schedule as legacy alias (P2-F)', () => {
      expect(parseMessage('/cron list')).toEqual({ type: 'cron', args: 'list' })
      expect(parseMessage('/schedule list')).toEqual({ type: 'cron', args: 'list', legacy: true })
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
      expect(result).toContain('Switched to test-agent')
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
      expect(result).toContain('not found')
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
        { type: 'error', prompt: '/bad', error: 'Unknown command: bad' },
        ctx
      )
      expect(result).toContain('Unknown command')
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
      expect(result).toContain('not available in your workspace')
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
      expect(result).toMatch(/not available|过于频繁|not configured/)
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
      expect(result).toContain('not found')
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
