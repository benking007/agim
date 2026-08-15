// agim-dispatcher — wiring sanity. The actual RPC handlers are
// covered by their own test files (skills-rpc / memo-rpc /
// ask-user-rpc / push-rpc / a2a); here we only verify that:
//   * `getAgimTools()` emits the expected mcp__agim__* tool names
//   * unknown tool names return source='unknown' so the combined
//     dispatcher can fall through to the next layer
//   * known names that hit a guard (e.g. ask_user with no question)
//     return an `isError: true` with `source: 'agim'` — the agent
//     loop will surface the message to the model.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearAgentCache } from '../onboarding.js'
import { registry } from '../registry.js'
import { buildAgimDispatcher, getAgimTools } from './agim-dispatcher.js'
import { loadFromConfig, _resetRegistry } from './registry.js'
import { LLM_SECRETS_PATH, saveSecret } from './secrets.js'

let pluginsLoaded = false

/** Register built-ins + mock LLM so Agim passes the call_agents dispatch probe. */
async function seedAgimAvailable(): Promise<void> {
  if (!pluginsLoaded) {
    await registry.loadBuiltInPlugins()
    pluginsLoaded = true
  }
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  saveSecret('native-mock', 'sk-test')
  loadFromConfig({
    llmBackends: [{ name: 'native-mock', provider: 'openai-compat', model: 'gpt' }],
  })
  clearAgentCache()
}

function clearAgimSeed(): void {
  _resetRegistry()
  clearAgentCache()
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
}

const NOOP_SIGNAL = new AbortController().signal

const CTX = {
  platform: 'test',
  channelId: 'c',
  threadId: 't',
  userId: 'u',
  callerAgent: 'native',
}

describe('getAgimTools', () => {
  it('exposes the expected mcp__agim__* tool names', () => {
    const names = getAgimTools().map((t) => t.name)
    expect(names).toContain('mcp__agim__read_skill')
    expect(names).toContain('mcp__agim__list_skills')
    expect(names).toContain('mcp__agim__save_memo')
    expect(names).toContain('mcp__agim__search_memos')
    expect(names).toContain('mcp__agim__update_memo')
    expect(names).toContain('mcp__agim__delete_memo')
    expect(names).toContain('mcp__agim__push_message')
    expect(names).toContain('mcp__agim__ask_user')
    expect(names).toContain('mcp__agim__call_agent')
    expect(names).toContain('mcp__agim__call_agents')
  })

  it('every tool has a non-empty description and a parameters object', () => {
    for (const t of getAgimTools()) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(10)
      expect(typeof t.parameters).toBe('object')
    }
  })

  it('call_agent / call_agents / ask_user / loop_verdict opt out of the Native 60s tool-bridge default', () => {
    const tools = getAgimTools()
    const callAgent = tools.find((t) => t.name === 'mcp__agim__call_agent')
    const callAgents = tools.find((t) => t.name === 'mcp__agim__call_agents')
    const askUser = tools.find((t) => t.name === 'mcp__agim__ask_user')
    const loopVerdict = tools.find((t) => t.name === 'mcp__agim__loop_verdict')
    // timeoutMs: 0 = no per-tool wall cap; A2A / ask_user / nested eval own their clocks.
    expect(callAgent?.timeoutMs).toBe(0)
    expect(callAgents?.timeoutMs).toBe(0)
    expect(askUser?.timeoutMs).toBe(0)
    expect(loopVerdict?.timeoutMs).toBe(0)
  })

  it('call_agents tool description advertises fan-out / allSettled heuristics', () => {
    const callAgents = getAgimTools().find((t) => t.name === 'mcp__agim__call_agents')
    expect(callAgents?.description.toLowerCase()).toMatch(/fan-out|multiple/)
    expect(callAgents?.description.toLowerCase()).toContain('allsettled')
  })
})

describe('buildAgimDispatcher', () => {
  it('unknown name returns source="unknown" so combineDispatchers falls through', async () => {
    const d = buildAgimDispatcher(CTX)
    const r = await d({ id: '1', name: 'not_a_real_tool', arguments: {} }, NOOP_SIGNAL)
    expect(r.source).toBe('unknown')
    expect(r.isError).toBe(true)
  })

  it('mcp__agim__* name with unknown op returns source="unknown" (falls through)', async () => {
    const d = buildAgimDispatcher(CTX)
    const r = await d({ id: '2', name: 'mcp__agim__not_an_op', arguments: {} }, NOOP_SIGNAL)
    expect(r.source).toBe('unknown')
  })

  it('list_skills succeeds (returns JSON with skills array)', async () => {
    const d = buildAgimDispatcher(CTX)
    const r = await d({ id: '3', name: 'mcp__agim__list_skills', arguments: {} }, NOOP_SIGNAL)
    expect(r.source).toBe('agim')
    expect(r.isError).toBe(false)
    // Body should be JSON-parseable and have a `skills` array.
    const parsed = JSON.parse(r.text)
    expect(Array.isArray(parsed.skills)).toBe(true)
  })

  it('ask_user with empty question reports a domain-level error (source="agim", isError=true)', async () => {
    const d = buildAgimDispatcher(CTX)
    const r = await d(
      { id: '4', name: 'mcp__agim__ask_user', arguments: { question: '', choices: ['a', 'b'] } },
      NOOP_SIGNAL,
    )
    expect(r.source).toBe('agim')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/question/i)
  })

  it('ask_user refused for Subagents (callerDepth>0)', async () => {
    const d = buildAgimDispatcher({ ...CTX, callerDepth: 1 })
    const r = await d(
      {
        id: '4b',
        name: 'mcp__agim__ask_user',
        arguments: { question: '选哪个？', choices: ['A', 'B'] },
      },
      NOOP_SIGNAL,
    )
    expect(r.source).toBe('agim')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Subagents cannot ask|callerDepth/i)
  })

  it('loop_verdict refused for Subagents (callerDepth>0)', async () => {
    const d = buildAgimDispatcher({ ...CTX, callerDepth: 1 })
    const r = await d(
      {
        id: '4c',
        name: 'mcp__agim__loop_verdict',
        arguments: { decision: 'stop', summary: 'x', met: false },
      },
      NOOP_SIGNAL,
    )
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/parent Loop orchestrator|callerDepth/i)
  })

  // v1.2.59 A — per-turn call_agent cap. Validates that after the cap the
  // dispatcher refuses further delegation with a self-correcting message.
  it('call_agent cap refuses delegation after AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN', async () => {
    const ORIG = process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN
    process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '1'
    try {
      // We mock by forcing missing args — call_agent's arg-validate runs
      // BEFORE the cap check on the first call, so the first call fails
      // with "requires both `agent` and `prompt`" not the cap. We pass
      // valid args; callAgentByName will probably error because there's
      // no real agent registered in the test env, but the cap check
      // happens before the actual A2A call, so on the SECOND call (with
      // valid args) the dispatcher should refuse with the cap message.
      const d = buildAgimDispatcher(CTX)
      // First call: counter goes to 1 (>= cap=1 only AFTER this call).
      // But the cap check is `>=` BEFORE incrementing, so first call
      // passes the cap check (0 >= 1 is false), increments counter to 1,
      // then attempts A2A which will fail because no agent is registered.
      const r1 = await d(
        { id: '5a', name: 'mcp__agim__call_agent', arguments: { agent: 'no-such-agent', prompt: 'x' } },
        NOOP_SIGNAL,
      )
      // r1 should fail because the agent doesn't exist — but it consumed
      // 1 cap slot. Verify it errored AT THE A2A LAYER, not the cap layer.
      expect(r1.isError).toBe(true)
      expect(r1.text).not.toMatch(/cap exceeded|already delegated/)

      // Second call: cap should now refuse (count=1 >= cap=1).
      const r2 = await d(
        { id: '5b', name: 'mcp__agim__call_agent', arguments: { agent: 'no-such-agent', prompt: 'y' } },
        NOOP_SIGNAL,
      )
      expect(r2.isError).toBe(true)
      expect(r2.source).toBe('agim')
      expect(r2.text).toMatch(/already delegated|refused/i)
    } finally {
      if (ORIG === undefined) delete process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN
      else process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = ORIG
    }
  })

  // Subagent Phase A1 — same-family spawn via callAgentByName (job/activity).
  describe('call_agent same-family Subagent (Phase A1)', () => {
    const SAVED = {
      depth: process.env.AGIM_A2A_MAX_DEPTH,
      inProc: process.env.AGIM_NATIVE_CALL_AGENT_IN_PROCESS,
      a2aEnabled: process.env.AGIM_A2A_ENABLED,
      capPerTurn: process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN,
    }
    function restoreEnv(): void {
      for (const [k, v] of [
        ['AGIM_A2A_MAX_DEPTH', SAVED.depth],
        ['AGIM_NATIVE_CALL_AGENT_IN_PROCESS', SAVED.inProc],
        ['AGIM_A2A_ENABLED', SAVED.a2aEnabled],
        ['AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN', SAVED.capPerTurn],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }

    it('refuses vacuous self-call without isolate/role/backend', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          { id: 'spawn-0', name: 'mcp__agim__call_agent', arguments: { agent: 'native', prompt: 'hi' } },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/isolate\/role\/backend/)
      } finally { restoreEnv() }
    })

    it('refuses unknown call_agent keys', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          {
            id: 'spawn-unk',
            name: 'mcp__agim__call_agent',
            arguments: { agent: 'agim', prompt: 'hi', isolate: true, foo: 1 },
          },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/unknown key/i)
      } finally { restoreEnv() }
    })

    it('refuses allowedTools on a cross-adapter target', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          {
            id: 'spawn-tools',
            name: 'mcp__agim__call_agent',
            arguments: {
              agent: 'claude-code',
              prompt: 'hi',
              allowedTools: ['agim_read_file'],
            },
          },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/allowedTools is only supported/i)
      } finally { restoreEnv() }
    })

    it('depth exceed: isolate same-family rejects when nextDepth > maxDepth', async () => {
      process.env.AGIM_A2A_MAX_DEPTH = '1'
      process.env.AGIM_NATIVE_CALL_AGENT_IN_PROCESS = 'on'
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher({ ...CTX, callerDepth: 1 })
      try {
        const r = await d(
          {
            id: 'spawn-1',
            name: 'mcp__agim__call_agent',
            arguments: { agent: 'native', prompt: 'hi', isolate: true },
          },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/depth|call depth exceeded/i)
      } finally { restoreEnv() }
    })

    it('A2A disabled: isolate same-family refuses', async () => {
      process.env.AGIM_A2A_ENABLED = '0'
      process.env.AGIM_NATIVE_CALL_AGENT_IN_PROCESS = 'on'
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          {
            id: 'spawn-2',
            name: 'mcp__agim__call_agent',
            arguments: { agent: 'native', prompt: 'hi', isolate: true },
          },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/A2A disabled/i)
      } finally { restoreEnv() }
    })

    it('cross-adapter unknown agent falls through to A2A error', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_IN_PROCESS = 'on'
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          { id: 'spawn-3', name: 'mcp__agim__call_agent', arguments: { agent: 'no-such-agent', prompt: 'hi' } },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/agent not found|not found/i)
      } finally { restoreEnv() }
    })

    it('getAgimTools advertises role/backend/isolate on call_agent', () => {
      const tools = getAgimTools()
      const callAgent = tools.find((t) => t.name === 'mcp__agim__call_agent')
      expect(callAgent).toBeTruthy()
      const props = (callAgent?.parameters as { properties?: Record<string, unknown> })?.properties ?? {}
      expect(props).toHaveProperty('role')
      expect(props).toHaveProperty('backend')
      expect(props).toHaveProperty('isolate')
      expect(props).toHaveProperty('outputFormat')
      expect(props).toHaveProperty('maxDepth')
      expect(props).toHaveProperty('allowedTools')
      expect((callAgent?.parameters as { additionalProperties?: boolean } | undefined)?.additionalProperties).toBe(false)
    })

    it('call_agent tool description locks Phase A3 decompose heuristics', async () => {
      const { SUBAGENT_HEURISTIC_KEYWORDS } = await import('../subagent-heuristics.js')
      const tools = getAgimTools()
      const callAgent = tools.find((t) => t.name === 'mcp__agim__call_agent')
      const desc = (callAgent?.description ?? '').toLowerCase()
      expect(desc.length).toBeGreaterThan(80)
      for (const kw of SUBAGENT_HEURISTIC_KEYWORDS) {
        expect(desc).toContain(kw.toLowerCase())
      }
      const promptProp = (callAgent?.parameters as {
        properties?: { prompt?: { description?: string } }
      })?.properties?.prompt?.description ?? ''
      expect(promptProp.toLowerCase()).toMatch(/objective/)
      expect(promptProp.toLowerCase()).toMatch(/done-when/)
    })
  })

  describe('call_agents batch fan-out (Phase B)', () => {
    const SAVED = {
      depth: process.env.AGIM_A2A_MAX_DEPTH,
      parallel: process.env.AGIM_SUBAGENT_PARALLEL,
      parallelMax: process.env.AGIM_SUBAGENT_PARALLEL_MAX,
      cap: process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN,
      a2aEnabled: process.env.AGIM_A2A_ENABLED,
    }
    function restoreEnv(): void {
      for (const [k, v] of Object.entries({
        AGIM_A2A_MAX_DEPTH: SAVED.depth,
        AGIM_SUBAGENT_PARALLEL: SAVED.parallel,
        AGIM_SUBAGENT_PARALLEL_MAX: SAVED.parallelMax,
        AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN: SAVED.cap,
        AGIM_A2A_ENABLED: SAVED.a2aEnabled,
      })) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }

    beforeEach(async () => { await seedAgimAvailable() })
    afterEach(() => clearAgimSeed())

    it('refuses empty tasks', async () => {
      const d = buildAgimDispatcher(CTX)
      const r = await d(
        { id: 'batch-0', name: 'mcp__agim__call_agents', arguments: { tasks: [] } },
        NOOP_SIGNAL,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/non-empty/i)
    })

    it('refuses vacuous same-family task without isolate/role/backend', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      try {
        const d = buildAgimDispatcher({ ...CTX, callerAgent: 'agim' })
        const r = await d(
          {
            id: 'batch-1',
            name: 'mcp__agim__call_agents',
            arguments: {
              tasks: [{ agent: 'agim', prompt: 'research A' }],
            },
          },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/isolate\/role\/backend|refused/i)
      } finally { restoreEnv() }
    })

    it('cap counts batch size against MAX_PER_TURN before fan-out', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '2'
      process.env.AGIM_A2A_ENABLED = '0'
      try {
        const d = buildAgimDispatcher({ ...CTX, callerAgent: 'agim' })
        const r = await d(
          {
            id: 'batch-2',
            name: 'mcp__agim__call_agents',
            arguments: {
              tasks: [
                { agent: 'agim', prompt: 'lane 1', isolate: true },
                { agent: 'agim', prompt: 'lane 2', isolate: true },
                { agent: 'agim', prompt: 'lane 3', isolate: true },
              ],
            },
          },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/cap=2/i)
        expect(r.text).toMatch(/\+3/)
      } finally { restoreEnv() }
    })

    it('cap refuse closes pending `${call.id}#i` cards (no ghost Waiting rows)', async () => {
      // Cap check runs before fan-out / availability probe — batch of 3 with
      // cap=2 is enough to reproduce the ghost-card bug without spawning.
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '2'
      process.env.AGIM_A2A_ENABLED = '0'
      const steps: Array<{ id: string; status: string; kind?: string }> = []
      try {
        const d = buildAgimDispatcher({
          ...CTX,
          callerAgent: 'agim',
          onToolActivity: (step) => { steps.push(step) },
        })
        const r = await d(
          {
            id: 'batch-ghost',
            name: 'mcp__agim__call_agents',
            arguments: {
              tasks: [
                { agent: 'agim', prompt: 'extra 1', isolate: true },
                { agent: 'agim', prompt: 'extra 2', isolate: true },
                { agent: 'agim', prompt: 'extra 3', isolate: true },
              ],
            },
          },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/cap=2/i)

        const closed = steps.filter((s) => (
          s.id.startsWith('batch-ghost#') && s.kind === 'agent' && s.status === 'error'
        ))
        expect(closed.map((s) => s.id).sort()).toEqual([
          'batch-ghost#0',
          'batch-ghost#1',
          'batch-ghost#2',
        ])
        // No jobId on refuse — these would have been Stop-less Waiting ghosts.
        expect(closed.every((s) => (s as { jobId?: number }).jobId == null)).toBe(true)
      } finally { restoreEnv() }
    })

    it('fan-out with A2A disabled returns allSettled-style join (per-lane errors)', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      process.env.AGIM_A2A_ENABLED = '0'
      process.env.AGIM_SUBAGENT_PARALLEL = '1'
      try {
        const d = buildAgimDispatcher({ ...CTX, callerAgent: 'agim' })
        const r = await d(
          {
            id: 'batch-3',
            name: 'mcp__agim__call_agents',
            arguments: {
              tasks: [
                { agent: 'agim', prompt: 'lane 1', isolate: true },
                { agent: 'agim', prompt: 'lane 2', isolate: true },
              ],
            },
          },
          NOOP_SIGNAL,
        )
        // Tool-level ok (allSettled); lanes report A2A disabled.
        expect(r.isError).toBe(false)
        expect(r.text).toMatch(/call_agents join/i)
        expect(r.text).toMatch(/0\/2 succeeded/)
        expect(r.text).toMatch(/A2A disabled|disabled/i)
      } finally { restoreEnv() }
    })
  })

  describe('Loop continue resets call_agent turn cap (R2 deadlock guard)', () => {
    let dir: string
    const SAVED = {
      loops: process.env.AGIM_LOOPS_DIR,
      a2a: process.env.AGIM_A2A_ENABLED,
      cap: process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN,
      parallel: process.env.AGIM_SUBAGENT_PARALLEL,
    }

    beforeEach(async () => {
      await seedAgimAvailable()
      dir = mkdtempSync(join(tmpdir(), 'loop-cap-reset-'))
      process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
      process.env.AGIM_A2A_ENABLED = '0'
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '3'
      process.env.AGIM_SUBAGENT_PARALLEL = '1'
    })

    afterEach(() => {
      clearAgimSeed()
      if (SAVED.loops === undefined) delete process.env.AGIM_LOOPS_DIR
      else process.env.AGIM_LOOPS_DIR = SAVED.loops
      if (SAVED.a2a === undefined) delete process.env.AGIM_A2A_ENABLED
      else process.env.AGIM_A2A_ENABLED = SAVED.a2a
      if (SAVED.cap === undefined) delete process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN
      else process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = SAVED.cap
      if (SAVED.parallel === undefined) delete process.env.AGIM_SUBAGENT_PARALLEL
      else process.env.AGIM_SUBAGENT_PARALLEL = SAVED.parallel
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    function seedPlanning(threadId: string, over: Record<string, unknown> = {}) {
      const platform = 'test'
      const channelId = 'c'
      const sessionKey = `${platform}__${channelId}__${threadId}`
      const now = Date.now()
      mkdirSync(process.env.AGIM_LOOPS_DIR!, { recursive: true, mode: 0o700 })
      writeFileSync(join(process.env.AGIM_LOOPS_DIR!, `${sessionKey}.json`), JSON.stringify({
        id: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
        sessionKey,
        platform,
        channelId,
        threadId,
        focusSnapshot: '补数据',
        openedFocus: false,
        status: 'planning',
        round: 1,
        maxRounds: 6,
        mission: {
          objective: '补齐恒生科技指数数据',
          exit: { description: '重复3轮', maxRounds: 6, minRounds: 1, onFocusOff: 'cancel' },
        },
        dispatchesThisRound: 0,
        roundJobIds: [],
        loopJobIds: [],
        usage: { dispatchCount: 0, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
        createdAt: now,
        updatedAt: now,
        timeline: [],
        ...over,
      }), 'utf8')
      return { platform, channelId, threadId }
    }

    it('continue|met=false resets cap; R2 call_agents is not refused', async () => {
      const threadId = `t-cap-${Date.now()}`
      seedPlanning(threadId)
      const d = buildAgimDispatcher({ ...CTX, threadId, callerAgent: 'agim' })

      const r1 = await d(
        {
          id: 'r1-batch',
          name: 'mcp__agim__call_agents',
          arguments: {
            tasks: [
              { agent: 'agim', prompt: 'lane A', isolate: true },
              { agent: 'agim', prompt: 'lane B', isolate: true },
              { agent: 'agim', prompt: 'lane C', isolate: true },
            ],
          },
        },
        NOOP_SIGNAL,
      )
      expect(r1.isError).toBe(false)

      // Without reset, another batch of 3 would exceed cap=3.
      const blocked = await d(
        {
          id: 'r1-again',
          name: 'mcp__agim__call_agents',
          arguments: {
            tasks: [
              { agent: 'agim', prompt: 'extra 1', isolate: true },
              { agent: 'agim', prompt: 'extra 2', isolate: true },
              { agent: 'agim', prompt: 'extra 3', isolate: true },
            ],
          },
        },
        NOOP_SIGNAL,
      )
      expect(blocked.isError).toBe(true)
      expect(blocked.text).toMatch(/already delegated|cap=3/i)
      expect(blocked.text).toMatch(/Active Loop|loop_verdict|continue/i)

      const verdict = await d(
        {
          id: 'r1-verdict',
          name: 'mcp__agim__loop_verdict',
          arguments: {
            decision: 'continue',
            met: false,
            summary: 'R1 缺数据，需补采',
            nextDirection: 'R2 补齐缺失字段',
            gaps: ['成交额', '市盈率'],
          },
        },
        NOOP_SIGNAL,
      )
      expect(verdict.isError).toBe(false)
      const parsed = JSON.parse(verdict.text) as { callAgentCapReset?: boolean; round?: number }
      expect(parsed.callAgentCapReset).toBe(true)
      expect(parsed.round).toBe(2)

      const r2 = await d(
        {
          id: 'r2-batch',
          name: 'mcp__agim__call_agents',
          arguments: {
            tasks: [
              { agent: 'agim', prompt: 'R2 lane 1', isolate: true },
              { agent: 'agim', prompt: 'R2 lane 2', isolate: true },
              { agent: 'agim', prompt: 'R2 lane 3', isolate: true },
            ],
          },
        },
        NOOP_SIGNAL,
      )
      expect(r2.isError).toBe(false)
      expect(r2.text).not.toMatch(/already delegated|cap exceeded/i)
      expect(r2.text).toMatch(/call_agents join/i)
    })

    it('planning + 0 dispatches clears stale turn history before first R2 dispatch', async () => {
      // Simulate "continue forgot to reset": exhaust cap with no Loop, then
      // open a planning Loop round and dispatch — belt-and-suspenders clear.
      const d = buildAgimDispatcher({ ...CTX, callerAgent: 'agim' })
      const exhaust = await d(
        {
          id: 'pre-loop',
          name: 'mcp__agim__call_agents',
          arguments: {
            tasks: [
              { agent: 'agim', prompt: 'pre 1', isolate: true },
              { agent: 'agim', prompt: 'pre 2', isolate: true },
              { agent: 'agim', prompt: 'pre 3', isolate: true },
            ],
          },
        },
        NOOP_SIGNAL,
      )
      expect(exhaust.isError).toBe(false)

      const threadId = CTX.threadId
      seedPlanning(threadId, { round: 2, status: 'planning', dispatchesThisRound: 0 })

      const r2 = await d(
        {
          id: 'r2-guard',
          name: 'mcp__agim__call_agents',
          arguments: {
            tasks: [
              { agent: 'agim', prompt: 'guard 1', isolate: true },
              { agent: 'agim', prompt: 'guard 2', isolate: true },
              { agent: 'agim', prompt: 'guard 3', isolate: true },
            ],
          },
        },
        NOOP_SIGNAL,
      )
      expect(r2.isError).toBe(false)
      expect(r2.text).toMatch(/call_agents join/i)
    })
  })

  describe('loop_verdict finds Loop across web channel aliases', () => {
    let dir: string
    const SAVED = { loops: process.env.AGIM_LOOPS_DIR }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'loop-verdict-alias-'))
      process.env.AGIM_LOOPS_DIR = join(dir, 'loops')
    })

    afterEach(() => {
      if (SAVED.loops === undefined) delete process.env.AGIM_LOOPS_DIR
      else process.env.AGIM_LOOPS_DIR = SAVED.loops
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('accepts continue when run is stored under web but tool ctx uses default', async () => {
      const threadId = `t-alias-${Date.now()}`
      const now = Date.now()
      mkdirSync(process.env.AGIM_LOOPS_DIR!, { recursive: true, mode: 0o700 })
      writeFileSync(join(process.env.AGIM_LOOPS_DIR!, `web__web__${threadId}.json`), JSON.stringify({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sessionKey: `web__web__${threadId}`,
        platform: 'web',
        channelId: 'web',
        threadId,
        focusSnapshot: '分析黄金',
        openedFocus: false,
        status: 'verifying',
        round: 1,
        maxRounds: 100,
        mission: {
          objective: '分析黄金',
          exit: { description: '验收通过或最多100轮', maxRounds: 100, onFocusOff: 'cancel' },
        },
        dispatchesThisRound: 3,
        roundJobIds: [],
        loopJobIds: [],
        usage: { dispatchCount: 3, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
        createdAt: now,
        updatedAt: now,
        timeline: [],
      }), 'utf8')

      const d = buildAgimDispatcher({
        platform: 'web',
        channelId: 'default',
        threadId,
        userId: 'u',
        callerAgent: 'agim',
      })
      const r = await d(
        {
          id: 'v1',
          name: 'mcp__agim__loop_verdict',
          arguments: {
            decision: 'continue',
            met: false,
            summary: '第一轮已汇总',
            nextDirection: '第二轮补缺口',
          },
        },
        NOOP_SIGNAL,
      )
      expect(r.isError).toBe(false)
      const parsed = JSON.parse(r.text) as { round?: number; status?: string }
      expect(parsed.round).toBe(2)
      expect(parsed.status).toBe('planning')
    })

    it('no_active_loop tells the model not to skip remaining rounds', async () => {
      const d = buildAgimDispatcher({
        platform: 'web',
        channelId: 'web',
        threadId: 'no-loop-here',
        userId: 'u',
        callerAgent: 'agim',
      })
      const r = await d(
        {
          id: 'v-miss',
          name: 'mcp__agim__loop_verdict',
          arguments: {
            decision: 'continue',
            met: false,
            summary: '第一轮已汇总',
            nextDirection: '第二轮',
          },
        },
        NOOP_SIGNAL,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/no_active_loop/)
      expect(r.text).toMatch(/Do not invent a substitute end-of-loop report/i)
    })
  })
})
