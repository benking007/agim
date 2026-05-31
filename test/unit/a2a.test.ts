// A2A — Layer 1 unit tests.
//
// What we can exercise without spawning real agents:
//   - env helpers (enabled / max-depth / timeout)
//   - depth-rejection branch in callAgentByName
//   - agent-not-found branch
//   - self-call rejection
//   - disabled branch (IMHUB_A2A_ENABLED=0)
//
// What we can't (and skip the DB suite for):
//   - jobs.parent_id / call_depth column persistence (bun + better-sqlite3
//     incompatible — same constraint as other DB tests)
//   - end-to-end agent invocation (needs a real adapter; staging job)

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-a2a-test-'))
process.env.AGIM_HOME = TEST_HOME

const a2a = await import('../../src/core/a2a.js')

// Snapshot env state we mutate so afterAll can restore it.
const ENV_SNAPSHOT: Record<string, string | undefined> = {
  IMHUB_A2A_ENABLED: process.env.IMHUB_A2A_ENABLED,
  IMHUB_A2A_MAX_DEPTH: process.env.IMHUB_A2A_MAX_DEPTH,
  IMHUB_A2A_TIMEOUT_DEFAULT_MS: process.env.IMHUB_A2A_TIMEOUT_DEFAULT_MS,
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

afterAll(() => {
  restoreEnv()
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

// Minimal RouteContext shape — enough to satisfy callAgentByName.
function fakeCtx(): Parameters<typeof a2a.callAgentByName>[2] {
  // We can't import the real Logger type without dragging pino into the
  // test, but the helpers we exercise only need `.warn / .info / .debug`.
  const noop = () => { /* no-op */ }
  const logger = {
    warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
    child: () => logger,
  } as unknown as ReturnType<typeof Object>
  return {
    threadId: 't', channelId: 'c', platform: 'test',
    defaultAgent: 'noop',
    traceId: 'trace',
    logger,
    userId: 'u',
  } as Parameters<typeof a2a.callAgentByName>[2]
}

describe('A2A env helpers', () => {
  beforeEach(() => { restoreEnv() })

  it('isA2AEnabled defaults true; IMHUB_A2A_ENABLED=0 disables', () => {
    delete process.env.IMHUB_A2A_ENABLED
    expect(a2a.isA2AEnabled()).toBe(true)
    process.env.IMHUB_A2A_ENABLED = '0'
    expect(a2a.isA2AEnabled()).toBe(false)
    process.env.IMHUB_A2A_ENABLED = '1'
    expect(a2a.isA2AEnabled()).toBe(true)
    process.env.IMHUB_A2A_ENABLED = ''
    // empty string is not '0' → still enabled
    expect(a2a.isA2AEnabled()).toBe(true)
  })

  it('getA2AMaxDepth defaults to A2A_MAX_DEPTH_DEFAULT (1 since v1.2.119); env override applies', () => {
    delete process.env.IMHUB_A2A_MAX_DEPTH
    expect(a2a.getA2AMaxDepth()).toBe(a2a.A2A_MAX_DEPTH_DEFAULT)
    expect(a2a.getA2AMaxDepth()).toBe(1)
    process.env.IMHUB_A2A_MAX_DEPTH = '7'
    expect(a2a.getA2AMaxDepth()).toBe(7)
    process.env.IMHUB_A2A_MAX_DEPTH = '0'
    expect(a2a.getA2AMaxDepth()).toBe(0)
    process.env.IMHUB_A2A_MAX_DEPTH = 'garbage'
    expect(a2a.getA2AMaxDepth()).toBe(a2a.A2A_MAX_DEPTH_DEFAULT)
  })

  it('getA2ATimeoutMs defaults to A2A_TIMEOUT_MS_DEFAULT; env override applies; rejects 0 / negative / NaN', () => {
    delete process.env.IMHUB_A2A_TIMEOUT_DEFAULT_MS
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
    process.env.IMHUB_A2A_TIMEOUT_DEFAULT_MS = '5000'
    expect(a2a.getA2ATimeoutMs()).toBe(5000)
    process.env.IMHUB_A2A_TIMEOUT_DEFAULT_MS = '0'
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
    process.env.IMHUB_A2A_TIMEOUT_DEFAULT_MS = '-1'
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
    process.env.IMHUB_A2A_TIMEOUT_DEFAULT_MS = 'x'
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
  })
})

describe('A2A callAgentByName rejection branches', () => {
  beforeEach(() => { restoreEnv() })

  it('returns disabled error when IMHUB_A2A_ENABLED=0', async () => {
    process.env.IMHUB_A2A_ENABLED = '0'
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('A2A disabled')
  })

  it('rejects depth + 1 > IMHUB_A2A_MAX_DEPTH', async () => {
    process.env.IMHUB_A2A_MAX_DEPTH = '2'
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), { callerDepth: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('call depth exceeded')
  })

  it('rejects self-call when callerAgent === target', async () => {
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), {
      callerAgent: 'claude-code',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('cannot call self')
  })

  it('rejects unknown agent name', async () => {
    const r = await a2a.callAgentByName('no-such-agent-xyz', 'hi', fakeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('agent not found')
  })

  it('depth check runs BEFORE the self-call check (defense in depth)', async () => {
    process.env.IMHUB_A2A_MAX_DEPTH = '0'
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), {
      callerAgent: 'claude-code',
      callerDepth: 0,
    })
    // depth ceiling = 0 means nextDepth=1 > 0 → depth rejection wins
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('call depth exceeded')
  })
})
