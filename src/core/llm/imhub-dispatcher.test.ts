// imhub-dispatcher — wiring sanity. The actual RPC handlers are
// covered by their own test files (skills-rpc / memo-rpc /
// ask-user-rpc / push-rpc / a2a); here we only verify that:
//   * `getImhubTools()` emits the expected mcp__imhub__* tool names
//   * unknown tool names return source='unknown' so the combined
//     dispatcher can fall through to the next layer
//   * known names that hit a guard (e.g. ask_user with no question)
//     return an `isError: true` with `source: 'imhub'` — the agent
//     loop will surface the message to the model.

import { describe, it, expect } from 'bun:test'
import { buildImhubDispatcher, getImhubTools } from './imhub-dispatcher.js'

const NOOP_SIGNAL = new AbortController().signal

const CTX = {
  platform: 'test',
  channelId: 'c',
  threadId: 't',
  userId: 'u',
  callerAgent: 'native',
}

describe('getImhubTools', () => {
  it('exposes the expected mcp__imhub__* tool names', () => {
    const names = getImhubTools().map((t) => t.name)
    expect(names).toContain('mcp__imhub__read_skill')
    expect(names).toContain('mcp__imhub__list_skills')
    expect(names).toContain('mcp__imhub__save_memo')
    expect(names).toContain('mcp__imhub__search_memos')
    expect(names).toContain('mcp__imhub__update_memo')
    expect(names).toContain('mcp__imhub__delete_memo')
    expect(names).toContain('mcp__imhub__push_message')
    expect(names).toContain('mcp__imhub__ask_user')
    expect(names).toContain('mcp__imhub__call_agent')
  })

  it('every tool has a non-empty description and a parameters object', () => {
    for (const t of getImhubTools()) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(10)
      expect(typeof t.parameters).toBe('object')
    }
  })
})

describe('buildImhubDispatcher', () => {
  it('unknown name returns source="unknown" so combineDispatchers falls through', async () => {
    const d = buildImhubDispatcher(CTX)
    const r = await d({ id: '1', name: 'not_a_real_tool', arguments: {} }, NOOP_SIGNAL)
    expect(r.source).toBe('unknown')
    expect(r.isError).toBe(true)
  })

  it('mcp__imhub__* name with unknown op returns source="unknown" (falls through)', async () => {
    const d = buildImhubDispatcher(CTX)
    const r = await d({ id: '2', name: 'mcp__imhub__not_an_op', arguments: {} }, NOOP_SIGNAL)
    expect(r.source).toBe('unknown')
  })

  it('list_skills succeeds (returns JSON with skills array)', async () => {
    const d = buildImhubDispatcher(CTX)
    const r = await d({ id: '3', name: 'mcp__imhub__list_skills', arguments: {} }, NOOP_SIGNAL)
    expect(r.source).toBe('imhub')
    expect(r.isError).toBe(false)
    // Body should be JSON-parseable and have a `skills` array.
    const parsed = JSON.parse(r.text)
    expect(Array.isArray(parsed.skills)).toBe(true)
  })

  it('ask_user with empty question reports a domain-level error (source="imhub", isError=true)', async () => {
    const d = buildImhubDispatcher(CTX)
    const r = await d(
      { id: '4', name: 'mcp__imhub__ask_user', arguments: { question: '', choices: ['a', 'b'] } },
      NOOP_SIGNAL,
    )
    expect(r.source).toBe('imhub')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/question/i)
  })
})
