// agim-dispatcher — wiring sanity. The actual RPC handlers are
// covered by their own test files (skills-rpc / memo-rpc /
// ask-user-rpc / push-rpc / a2a); here we only verify that:
//   * `getAgimTools()` emits the expected mcp__agim__* tool names
//   * unknown tool names return source='unknown' so the combined
//     dispatcher can fall through to the next layer
//   * known names that hit a guard (e.g. ask_user with no question)
//     return an `isError: true` with `source: 'agim'` — the agent
//     loop will surface the message to the model.

import { describe, it, expect } from 'bun:test'
import { buildAgimDispatcher, getAgimTools } from './agim-dispatcher.js'

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
  })

  it('every tool has a non-empty description and a parameters object', () => {
    for (const t of getAgimTools()) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(10)
      expect(typeof t.parameters).toBe('object')
    }
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

  // v1.2.121 — in-process native self-spawn fast path.
  describe('call_agent in-process native self-spawn (v1.2.121)', () => {
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

    it('depth exceed: in-process branch rejects when nextDepth > maxDepth', async () => {
      process.env.AGIM_A2A_MAX_DEPTH = '1'
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      // Already-deep caller (depth=1) → nextDepth=2 > max=1 → reject.
      const d = buildAgimDispatcher({ ...CTX, callerDepth: 1 })
      try {
        const r = await d(
          { id: 'spawn-1', name: 'mcp__agim__call_agent', arguments: { agent: 'native', prompt: 'hi' } },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        // The in-process branch rejects with explicit depth message,
        // not the cap-exceeded path.
        expect(r.text).toMatch(/depth 2 > max 1/)
      } finally { restoreEnv() }
    })

    it('A2A disabled: in-process branch refuses', async () => {
      process.env.AGIM_A2A_ENABLED = '0'
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          { id: 'spawn-2', name: 'mcp__agim__call_agent', arguments: { agent: 'native', prompt: 'hi' } },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/A2A disabled/i)
      } finally { restoreEnv() }
    })

    it('non-native target skips the in-process branch (falls through to subprocess A2A)', async () => {
      // We can't easily mount a real agent here, but we can verify the
      // failure path: callAgentByName for an unknown agent returns an
      // A2A-layer error string, distinct from the in-process branch's
      // "depth N > max" or "A2A disabled" messages.
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          { id: 'spawn-3', name: 'mcp__agim__call_agent', arguments: { agent: 'no-such-agent', prompt: 'hi' } },
          NOOP_SIGNAL,
        )
        expect(r.isError).toBe(true)
        // Must NOT match the in-process branch's reject messages.
        expect(r.text).not.toMatch(/in-process native/i)
        expect(r.text).not.toMatch(/depth \d+ > max/)
      } finally { restoreEnv() }
    })

    it('kill switch: AGIM_NATIVE_CALL_AGENT_IN_PROCESS=off forces subprocess path', async () => {
      process.env.AGIM_NATIVE_CALL_AGENT_IN_PROCESS = 'off'
      process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '5'
      const d = buildAgimDispatcher(CTX)
      try {
        const r = await d(
          { id: 'spawn-4', name: 'mcp__agim__call_agent', arguments: { agent: 'native', prompt: 'hi' } },
          NOOP_SIGNAL,
        )
        // With in-process disabled, we hit callAgentByName for 'native'
        // which goes through the subprocess A2A path. If no native is
        // registered in this test env, we expect a non-in-process
        // error message (i.e. text NOT matching the in-process spawn
        // log signature).
        expect(r.isError).toBe(true)
        expect(r.text).not.toMatch(/in-process/i)
      } finally { restoreEnv() }
    })
  })
})
