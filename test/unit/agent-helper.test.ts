// agent-helper.ts — generic LLM-via-AgentAdapter helper, unit tests.
//
// All tests use a fake AgentAdapter so we don't depend on a real agent CLI.
// They also stub session resolution to keep this purely about the helper.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { callHelperAgent, callHelperForJson, resolveActiveAgent } from '../../src/core/agent-helper.js'
import { registry } from '../../src/core/registry.js'
import type { AgentAdapter, ChatMessage } from '../../src/core/types.js'

interface FakeOpts {
  name?: string
  output?: string
  /** Per-chunk delay so we can exercise the timeout path. */
  delayPerChunkMs?: number
  throwOnInvoke?: boolean
}

function fakeAgent(opts: FakeOpts = {}): AgentAdapter {
  const name = opts.name ?? 'fake-agent'
  return {
    name,
    aliases: [] as string[],
    async *sendPrompt(_sessionId: string, _prompt: string, _history?: ChatMessage[]) {
      if (opts.throwOnInvoke) throw new Error('synthetic agent failure')
      const text = opts.output ?? 'hello'
      // Stream char by char, optionally with a delay.
      for (const ch of text) {
        if (opts.delayPerChunkMs) await new Promise((r) => setTimeout(r, opts.delayPerChunkMs))
        yield ch
      }
    },
  } as unknown as AgentAdapter
}

const PLATFORM = 'helper-test'
const CHANNEL = 'c'
const THREAD = 't'

describe('agent-helper.callHelperAgent', () => {
  let registered: string[] = []
  beforeEach(() => { registered = [] })
  afterEach(() => {
    // Best-effort: registry doesn't expose unregister; leave stale fake
    // adapters behind, scoped by unique names per test.
  })

  it('returns null when no agent is available', async () => {
    const result = await callHelperAgent({
      platform: PLATFORM, channelId: CHANNEL, threadId: THREAD,
      systemPrompt: 'sys', userPrompt: 'user',
      // Force resolveActiveAgent to find nothing by passing a non-existent name
      agentName: '__no_such_agent__',
    })
    expect(result).toBeNull()
  })

  it('streams output from the resolved agent', async () => {
    const name = 'helper-fake-' + Date.now()
    registry.registerMessenger as unknown // satisfy lint
    registry.registerAgent(fakeAgent({ name, output: 'polished text' }))
    registered.push(name)
    const result = await callHelperAgent({
      platform: PLATFORM, channelId: CHANNEL, threadId: THREAD,
      systemPrompt: 'sys', userPrompt: 'user',
      agentName: name,
    })
    expect(result).toBe('polished text')
  })

  it('honors maxOutputChars by truncating the stream', async () => {
    const name = 'helper-trunc-' + Date.now()
    registry.registerAgent(fakeAgent({ name, output: 'x'.repeat(200) }))
    const result = await callHelperAgent({
      platform: PLATFORM, channelId: CHANNEL, threadId: THREAD,
      systemPrompt: 'sys', userPrompt: 'user',
      agentName: name,
      maxOutputChars: 50,
    })
    expect(result).not.toBeNull()
    expect(result!.length).toBe(50)
  })

  it('returns null on timeout', async () => {
    const name = 'helper-slow-' + Date.now()
    registry.registerAgent(fakeAgent({
      name,
      output: 'never-finishes',
      delayPerChunkMs: 50,
    }))
    const result = await callHelperAgent({
      platform: PLATFORM, channelId: CHANNEL, threadId: THREAD,
      systemPrompt: 'sys', userPrompt: 'user',
      agentName: name,
      timeoutMs: 100,
    })
    expect(result).toBeNull()
  })

  it('returns null when the agent throws', async () => {
    const name = 'helper-throw-' + Date.now()
    registry.registerAgent(fakeAgent({ name, throwOnInvoke: true }))
    const result = await callHelperAgent({
      platform: PLATFORM, channelId: CHANNEL, threadId: THREAD,
      systemPrompt: 'sys', userPrompt: 'user',
      agentName: name,
    })
    expect(result).toBeNull()
  })
})

describe('agent-helper.callHelperForJson', () => {
  it('extracts JSON from a noisy response', async () => {
    const name = 'json-fake-' + Date.now()
    registry.registerAgent(fakeAgent({
      name,
      output: 'Here is the JSON:\n```json\n{"a": 1, "b": "hi"}\n```\nDone.',
    }))
    const result = await callHelperForJson<{ a: number; b: string }>({
      platform: PLATFORM, channelId: CHANNEL, threadId: THREAD,
      systemPrompt: 'sys', userPrompt: 'user',
      agentName: name,
    })
    expect(result).not.toBeNull()
    expect(result!.a).toBe(1)
    expect(result!.b).toBe('hi')
  })

  it('returns null when no JSON object is in the response', async () => {
    const name = 'json-empty-' + Date.now()
    registry.registerAgent(fakeAgent({ name, output: 'just prose, no curly braces' }))
    const result = await callHelperForJson({
      platform: PLATFORM, channelId: CHANNEL, threadId: THREAD,
      systemPrompt: 'sys', userPrompt: 'user',
      agentName: name,
    })
    expect(result).toBeNull()
  })
})

describe('agent-helper.resolveActiveAgent', () => {
  it('uses the session agent when present', async () => {
    const got = await resolveActiveAgent('p', 'c', 't', {
      getExistingSession: async () => ({
        id: 'x', channelId: 'c', threadId: 't', platform: 'p',
        agent: 'session-agent',
        createdAt: new Date(), lastActivity: new Date(),
        ttl: 0, messages: [],
      }),
      listAgents: () => ['fallback-1', 'fallback-2'],
    })
    expect(got).toBe('session-agent')
  })

  it('falls back to the first registered agent', async () => {
    const got = await resolveActiveAgent('p', 'c', 't', {
      getExistingSession: async () => undefined,
      listAgents: () => ['fallback-1', 'fallback-2'],
    })
    expect(got).toBe('fallback-1')
  })

  it('returns null when no agent is registered', async () => {
    const got = await resolveActiveAgent('p', 'c', 't', {
      getExistingSession: async () => undefined,
      listAgents: () => [],
    })
    expect(got).toBeNull()
  })
})
