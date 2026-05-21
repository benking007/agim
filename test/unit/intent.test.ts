// Unit tests for the rule-based intent classifier

import { describe, it, expect, beforeEach } from 'bun:test'
import { classifyIntent } from '../../src/core/intent'
import { registry } from '../../src/core/registry'
import { circuitBreaker } from '../../src/core/circuit-breaker'
import type { AgentAdapter } from '../../src/core/types'

function makeAgent(name: string, aliases: string[] = []): AgentAdapter {
  return {
    name,
    aliases,
    isAvailable: async () => true,
    sendPrompt: async function* () { yield '' },
  }
}

// Make sure all profiled agents are registered so PROFILES weights apply.
function registerProfiledAgents(): void {
  registry.registerAgent(makeAgent('opencode', ['oc']))
  registry.registerAgent(makeAgent('claude-code', ['cc']))
  registry.registerAgent(makeAgent('codex', ['cx']))
}

describe('classifyIntent', () => {
  beforeEach(() => {
    registerProfiledAgents()
    // Reset breaker state between tests
    for (const a of ['opencode', 'claude-code', 'codex']) {
      circuitBreaker.recordSuccess(a)
    }
  })

  it('throws when no agents are registered/available', () => {
    // Force-open every profiled agent so the available list is empty
    for (const a of ['opencode', 'claude-code', 'codex']) {
      for (let i = 0; i < 3; i++) circuitBreaker.recordFailure(a)
    }
    // Also force-open any other registered agents (e.g. test-agent from earlier suites)
    for (const a of registry.listAgents()) {
      for (let i = 0; i < 3; i++) circuitBreaker.recordFailure(a)
    }
    expect(() => classifyIntent('hello')).toThrow('No agents available')
  })

  it('routes git/commit messages to opencode via topic rule', () => {
    const result = classifyIntent('please git commit this branch')
    expect(result.agent).toBe('opencode')
    expect(['keyword', 'topic']).toContain(result.triggeredBy)
    expect(result.score).toBeGreaterThan(0)
  })

  it('routes review/explain messages to claude-code', () => {
    const result = classifyIntent('please review this design and explain the tradeoffs')
    expect(result.agent).toBe('claude-code')
  })

  it('respects sticky session bias when message is generic', () => {
    const result = classifyIntent('thanks', 'codex')
    expect(result.agent).toBe('codex')
    expect(result.triggeredBy).toBe('sticky')
  })

  it('skips agents with an open circuit breaker', () => {
    // Open opencode
    for (let i = 0; i < 3; i++) circuitBreaker.recordFailure('opencode')
    const result = classifyIntent('git commit and push to main')
    expect(result.agent).not.toBe('opencode')
  })

  it('rounds the score to two decimals', () => {
    const result = classifyIntent('refactor this code please')
    expect(Number.isInteger(result.score * 100) || Math.abs(result.score * 100 - Math.round(result.score * 100)) < 1e-9).toBe(true)
  })

  it('returns a non-empty reason string', () => {
    const result = classifyIntent('refactor this typescript code')
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('matches Chinese topic keywords (no \\b regression)', () => {
    // \b doesn't fire on CJK boundaries — verify our Unicode-aware regex
    // still picks up `审查` and `测试` even when they sit between Chinese
    // characters with no spaces.
    const review = classifyIntent('帮我审查这段代码')
    expect(review.agent).toBe('claude-code')
    expect(review.reason).toContain('topic:')

    const testing = classifyIntent('帮我写测试用例')
    expect(testing.agent).toBe('opencode')
  })

  it('triggeredBy is "topic" when a topic rule fires', () => {
    const result = classifyIntent('git commit and push')
    expect(result.triggeredBy).toBe('topic')
  })

  it('non-PROFILES custom agents receive default weight and remain selectable', () => {
    // Register an agent without a PROFILES entry — simulates ACP custom agent.
    const customAgent: AgentAdapter = {
      name: 'my-custom-agent',
      aliases: [],
      isAvailable: async () => true,
      sendPrompt: async function* () { yield '' },
    }
    registry.registerAgent(customAgent)
    // sticky bias should let the custom agent win even with no profile.
    const result = classifyIntent('hello there', 'my-custom-agent')
    expect(result.agent).toBe('my-custom-agent')
    expect(result.triggeredBy).toBe('sticky')
  })

  it('breaks ties deterministically (sticky > PROFILES order > alphabetical)', () => {
    // No keyword/topic match → all profiled agents equal on base weight.
    // Sticky should win.
    const stickyResult = classifyIntent('ok thanks', 'codex')
    expect(stickyResult.agent).toBe('codex')
  })

  it('routes generic messages to defaultAgent when no sticky/topic/keyword signal', () => {
    // Without defaultAgent, a generic "hello" falls into PROFILES order
    // (opencode wins). With defaultAgent set, the bias should route it to
    // the operator's chosen agent — matches the web /chat fresh-thread
    // path where there's no sticky session yet.
    const r = classifyIntent('hello', undefined, undefined, 'claude-code')
    expect(r.agent).toBe('claude-code')
    expect(r.triggeredBy).toBe('default')
  })

  it('defaultAgent loses to an explicit topic match', () => {
    // Even with defaultAgent=claude-code, a "git commit" message must still
    // route to opencode — explicit topic signal overrides the default bias.
    const r = classifyIntent('git commit and push to main', undefined, undefined, 'claude-code')
    expect(r.agent).toBe('opencode')
    expect(r.triggeredBy).toBe('topic')
  })

  it('defaultAgent loses to sticky', () => {
    // Sticky session is an absolute lock; defaultAgent never overrides it.
    const r = classifyIntent('hello', 'codex', undefined, 'claude-code')
    expect(r.agent).toBe('codex')
    expect(r.triggeredBy).toBe('sticky')
  })

  it('defaultAgent that is not registered is ignored', () => {
    // An operator who configures defaultAgent to an unregistered name
    // shouldn't crash routing — we silently fall back to PROFILES order.
    const r = classifyIntent('hello', undefined, undefined, 'no-such-agent')
    expect(['opencode', 'claude-code', 'codex']).toContain(r.agent)
    expect(r.triggeredBy).not.toBe('default')
  })

  it('defaultAgent === stickyAgent: sticky wins, no double-counted bias', () => {
    // R13: regression lock for the `defaultAgent !== stickyAgent` guard
    // in classifyIntent. When the operator's default equals the current
    // sticky agent, the function must NOT credit a second +1 bias on
    // top of the sticky's +3 — that would be cosmetically fine (sticky
    // still wins) but would corrupt the score field used for
    // observability (router.intent log line) and confuse the dirty
    // edge cases in scoring tie-breaks if topic / keyword ever land
    // on the sticky agent.
    const r = classifyIntent('hello', 'codex', undefined, 'codex')
    expect(r.agent).toBe('codex')
    expect(r.triggeredBy).toBe('sticky')
    // Sticky short-circuit returns early with score:0 — no scoring
    // pass ran, so the defaultAgent bias path is unreachable. Verify
    // we get the short-circuit shape (not the regular scoring path).
    expect(r.score).toBe(0)
    expect(r.reason).toBe('sticky lock (no classification)')
  })
})
