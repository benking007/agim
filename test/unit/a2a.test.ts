// A2A — Layer 1 unit tests.
//
// What we can exercise without spawning real agents:
//   - env helpers (enabled / max-depth / timeout)
//   - depth-rejection branch in callAgentByName
//   - agent-not-found branch
//   - self-call rejection
//   - disabled branch (AGIM_A2A_ENABLED=0)
//
// What we can't (and skip the DB suite for):
//   - jobs.parent_id / call_depth column persistence (bun + better-sqlite3
//     incompatible — same constraint as other DB tests)
//   - end-to-end agent invocation (needs a real adapter; staging job)

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-a2a-test-'))
process.env.AGIM_HOME = TEST_HOME

const a2a = await import('../../src/core/a2a.js')
const artifacts = await import('../../src/core/artifacts.js')

// Snapshot env state we mutate so afterAll can restore it.
const ENV_SNAPSHOT: Record<string, string | undefined> = {
  AGIM_A2A_ENABLED: process.env.AGIM_A2A_ENABLED,
  AGIM_A2A_MAX_DEPTH: process.env.AGIM_A2A_MAX_DEPTH,
  AGIM_A2A_TIMEOUT_DEFAULT_MS: process.env.AGIM_A2A_TIMEOUT_DEFAULT_MS,
  AGIM_A2A_MAX_RESULT_CHARS: process.env.AGIM_A2A_MAX_RESULT_CHARS,
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

  it('getA2AMaxResultChars: default / 0-disables / override / bad→default', () => {
    delete process.env.AGIM_A2A_MAX_RESULT_CHARS
    expect(a2a.getA2AMaxResultChars()).toBe(a2a.A2A_MAX_RESULT_CHARS_DEFAULT)
    process.env.AGIM_A2A_MAX_RESULT_CHARS = '0'
    expect(a2a.getA2AMaxResultChars()).toBe(0)
    process.env.AGIM_A2A_MAX_RESULT_CHARS = '1234'
    expect(a2a.getA2AMaxResultChars()).toBe(1234)
    process.env.AGIM_A2A_MAX_RESULT_CHARS = 'abc'
    expect(a2a.getA2AMaxResultChars()).toBe(a2a.A2A_MAX_RESULT_CHARS_DEFAULT)
  })

  it('isA2AEnabled defaults true; AGIM_A2A_ENABLED=0 disables', () => {
    delete process.env.AGIM_A2A_ENABLED
    expect(a2a.isA2AEnabled()).toBe(true)
    process.env.AGIM_A2A_ENABLED = '0'
    expect(a2a.isA2AEnabled()).toBe(false)
    process.env.AGIM_A2A_ENABLED = '1'
    expect(a2a.isA2AEnabled()).toBe(true)
    process.env.AGIM_A2A_ENABLED = ''
    // empty string is not '0' → still enabled
    expect(a2a.isA2AEnabled()).toBe(true)
  })

  it('getA2AMaxDepth defaults to A2A_MAX_DEPTH_DEFAULT (8); env override applies', () => {
    delete process.env.AGIM_A2A_MAX_DEPTH
    expect(a2a.getA2AMaxDepth()).toBe(a2a.A2A_MAX_DEPTH_DEFAULT)
    expect(a2a.getA2AMaxDepth()).toBe(8)
    process.env.AGIM_A2A_MAX_DEPTH = '7'
    expect(a2a.getA2AMaxDepth()).toBe(7)
    process.env.AGIM_A2A_MAX_DEPTH = '0'
    expect(a2a.getA2AMaxDepth()).toBe(0)
    process.env.AGIM_A2A_MAX_DEPTH = 'garbage'
    expect(a2a.getA2AMaxDepth()).toBe(a2a.A2A_MAX_DEPTH_DEFAULT)
  })

  it('getA2ATimeoutMs defaults to A2A_TIMEOUT_MS_DEFAULT; env override applies; rejects 0 / negative / NaN', () => {
    delete process.env.AGIM_A2A_TIMEOUT_DEFAULT_MS
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
    process.env.AGIM_A2A_TIMEOUT_DEFAULT_MS = '5000'
    expect(a2a.getA2ATimeoutMs()).toBe(5000)
    process.env.AGIM_A2A_TIMEOUT_DEFAULT_MS = '0'
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
    process.env.AGIM_A2A_TIMEOUT_DEFAULT_MS = '-1'
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
    process.env.AGIM_A2A_TIMEOUT_DEFAULT_MS = 'x'
    expect(a2a.getA2ATimeoutMs()).toBe(a2a.A2A_TIMEOUT_MS_DEFAULT)
  })
})

describe('A2A callAgentByName rejection branches', () => {
  beforeEach(() => { restoreEnv() })

  it('returns disabled error when AGIM_A2A_ENABLED=0', async () => {
    process.env.AGIM_A2A_ENABLED = '0'
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('A2A disabled')
  })

  it('rejects depth + 1 > AGIM_A2A_MAX_DEPTH', async () => {
    process.env.AGIM_A2A_MAX_DEPTH = '2'
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), { callerDepth: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('call depth exceeded')
  })

  it('rejects self-call when callerAgent === target without isolate/model', async () => {
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), {
      callerAgent: 'claude-code',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('cannot call self')
  })

  it('allows same-agent Subagent past self-call gate when isolate:true', async () => {
    // Still fails later (agent may be missing / unavailable), but must NOT
    // be the vacuous self-call rejection.
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), {
      callerAgent: 'claude-code',
      isolate: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toMatch(/cannot call self/)
  })

  it('allows same-agent Subagent past self-call gate when model is set', async () => {
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), {
      callerAgent: 'claude-code',
      model: 'deepseek-v4-flash',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toMatch(/cannot call self/)
  })

  it('rejects unknown agent name', async () => {
    const r = await a2a.callAgentByName('no-such-agent-xyz', 'hi', fakeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('agent not found')
  })

  it('normalizes legacy agent id agim/native before lookup', async () => {
    const steps: Array<{ id: string; status: string; preview?: string }> = []
    const r = await a2a.callAgentByName('agim/native', 'hi', fakeCtx(), {
      callerAgent: 'agim',
      isolate: true,
      activityStepId: 'tool-1',
      activityLabel: 'agim',
      onToolActivity: (step) => { steps.push(step) },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Must not keep the slash form as a missing registry id.
      expect(r.error).not.toContain('agent not found: agim/native')
      expect(r.error).toMatch(/agent not found: agim|not in workspace|A2A disabled/)
    }
    expect(steps.some((s) => s.id === 'tool-1' && s.status === 'error')).toBe(true)
  })

  it('depth check runs BEFORE the self-call check (defense in depth)', async () => {
    process.env.AGIM_A2A_MAX_DEPTH = '0'
    const r = await a2a.callAgentByName('claude-code', 'hi', fakeCtx(), {
      callerAgent: 'claude-code',
      callerDepth: 0,
    })
    // depth ceiling = 0 means nextDepth=1 > 0 → depth rejection wins
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('call depth exceeded')
  })
})

describe('compressA2AResult (sub-output compression)', () => {
  beforeEach(() => { restoreEnv(); delete process.env.AGIM_A2A_MAX_RESULT_CHARS })

  it('returns short results unchanged and writes no spill file', async () => {
    const jobId = 770001
    expect(await a2a.compressA2AResult(jobId, 'short result')).toBe('short result')
    expect(await artifacts.readOutput(jobId, a2a.A2A_FULL_RESULT_FILE)).toBeNull()
  })

  it('truncates over-cap results and spills the full text to _agim-output', async () => {
    process.env.AGIM_A2A_MAX_RESULT_CHARS = '100'
    const jobId = 770002
    const full = 'x'.repeat(500)
    const out = await a2a.compressA2AResult(jobId, full)
    expect(out.length).toBeLessThan(full.length)
    expect(out).toContain('已截断')
    expect(out).toContain(a2a.A2A_FULL_RESULT_FILE)
    expect((await artifacts.readOutput(jobId, a2a.A2A_FULL_RESULT_FILE))?.toString()).toBe(full)
  })

  it('cap=0 disables truncation (returns full text)', async () => {
    process.env.AGIM_A2A_MAX_RESULT_CHARS = '0'
    const full = 'y'.repeat(9000)
    expect(await a2a.compressA2AResult(770003, full)).toBe(full)
  })
})


describe('formatSubagentStoppedResult', () => {
  it('includes partial output and parent continue instructions', () => {
    const out = a2a.formatSubagentStoppedResult('half done findings')
    expect(out).toContain('[Subagent stopped by user]')
    expect(out).toContain('half done findings')
    expect(out).toMatch(/Summarize|continue/i)
  })
})

describe('isAbortReasonTimeout', () => {
  it('detects TimeoutError name and timed-out messages', () => {
    const dom = new Error('The operation was aborted due to timeout')
    dom.name = 'TimeoutError'
    expect(a2a.isAbortReasonTimeout(dom)).toBe(true)
    expect(a2a.isAbortReasonTimeout(new Error('native run timed out after 60000ms'))).toBe(true)
    expect(a2a.isAbortReasonTimeout(new Error('工具 mcp__agim__call_agent 执行超过 60000ms 已超时'))).toBe(true)
    expect(a2a.isAbortReasonTimeout(new Error('a2a aborted'))).toBe(false)
    expect(a2a.isAbortReasonTimeout(undefined)).toBe(false)
  })
})
