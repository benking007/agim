// v1.2.139 — regressions for sub-agent (call_agent) hardening:
//
//   1. CallAgentOpts.planMode propagates through callAgentByName to the
//      target adapter's sendPrompt(opts).planMode. Without this, a
//      parent in `/plan on` could delegate write work to claude-code /
//      opencode / sub-native and the child would launch with full write
//      access, bypassing user intent.
//
//   2. applyOutputCap() truncates a chatty sub-agent reply with a clear
//      marker and (best-effort) viewer-paste spill so the parent
//      context budget isn't blown by 8000+ char dumps from 2-3 nested
//      sub-agents.
//
//   3. isTransientSubAgentError() recognises the typical transient
//      failure surface (5xx / 408 / ECONN* / fetch failed / socket
//      hang up / network) so the dispatcher retries once, and rejects
//      permanent errors (4xx / model refusal) so we don't loop on
//      unrecoverable failures.
//
// Doesn't exercise: actual MCP wire shape, IM bridge, web/viewer round-trip.
// Those are integration-shaped concerns — unit tests stay focused on the
// surface the dispatcher controls.

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agim-call-agent-test-'))
process.env.AGIM_HOME = TEST_HOME

const a2a = await import('../../src/core/a2a.js')
const { registry } = await import('../../src/core/registry.js')
const {
  applyOutputCap,
  isTransientSubAgentError,
  resolveSubAgentOutputCap,
} = await import('../../src/core/llm/agim-dispatcher.js')

import type { AgentAdapter, AgentSendOpts } from '../../src/core/types.js'

const ENV_KEYS = [
  'AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS',
  'AGIM_A2A_ENABLED',
  'AGIM_A2A_MAX_DEPTH',
] as const
const ENV_SNAPSHOT: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k]

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k]
    else process.env[k] = ENV_SNAPSHOT[k]
  }
}

afterAll(() => {
  restoreEnv()
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

function fakeRouteCtx(): Parameters<typeof a2a.callAgentByName>[2] {
  const noop = () => { /* no-op */ }
  const logger = {
    warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
    child: () => logger,
  } as unknown as ReturnType<typeof Object>
  return {
    threadId: 't', channelId: 'c', platform: 'test',
    defaultAgent: 'noop', traceId: 'trace', userId: 'u', logger,
  } as Parameters<typeof a2a.callAgentByName>[2]
}

describe('v1.2.139 — applyOutputCap()', () => {
  beforeEach(() => { restoreEnv() })

  it('returns input unchanged when under the cap', () => {
    process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS = '100'
    const short = 'a'.repeat(50)
    expect(applyOutputCap(short, 'codex', null)).toBe(short)
  })

  it('truncates with head + tail + marker when over the cap (large cap)', () => {
    // Cap large enough for both head (70%) AND tail (cap - head - 200
    // marker reserve) to be positive — the production default 8000
    // is in this regime. With cap=2000: head=1400, tail=2000-1400-200=400.
    process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS = '2000'
    const big = 'HEAD'.repeat(500) + 'MIDDLE'.repeat(100) + 'TAIL'.repeat(500)
    const out = applyOutputCap(big, 'claude-code', 42)
    expect(out.length).toBeLessThan(big.length)
    expect(out).toMatch(/truncated \d+ of \d+ chars/)
    expect(out).toContain('cap=AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS=2000')
    // Head preserved
    expect(out.startsWith('HEAD')).toBe(true)
    // Tail preserved (last block of the original) — confirms we keep
    // BOTH ends, not just head.
    expect(out).toContain('TAIL')
  })

  it('skips tail when the cap is too small to afford one (head + marker only)', () => {
    // cap=500: head 70% = 350, tail = 500 - 350 - 200 = -50 → clamped 0.
    // Small-cap regime intentionally drops the tail — the marker still
    // tells the model how much was dropped.
    process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS = '500'
    const big = 'HEAD'.repeat(250) + 'TAIL'.repeat(250)
    const out = applyOutputCap(big, 'codex', null)
    expect(out).toMatch(/truncated \d+ of \d+ chars/)
    // Trailing "TAIL" not preserved at this cap size — by design.
    // Head IS preserved.
    expect(out.startsWith('HEAD')).toBe(true)
  })

  it('respects 0 as disable (no truncation regardless of length)', () => {
    process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS = '0'
    const big = 'x'.repeat(20000)
    expect(applyOutputCap(big, 'codex', null)).toBe(big)
  })

  it('resolveSubAgentOutputCap defaults to 8000 when unset / garbage', () => {
    delete process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS
    expect(resolveSubAgentOutputCap()).toBe(8000)
    process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS = 'bogus'
    expect(resolveSubAgentOutputCap()).toBe(8000)
    process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS = '-1'
    expect(resolveSubAgentOutputCap()).toBe(8000)
    process.env.AGIM_NATIVE_CALL_AGENT_OUTPUT_MAX_CHARS = '1234'
    expect(resolveSubAgentOutputCap()).toBe(1234)
  })
})

describe('v1.2.139 — isTransientSubAgentError()', () => {
  it('matches typical transient surfaces', () => {
    expect(isTransientSubAgentError('upstream 503 Service Unavailable')).toBe(true)
    expect(isTransientSubAgentError('504 gateway timeout')).toBe(true)
    expect(isTransientSubAgentError('Request Timeout (408)')).toBe(true)
    expect(isTransientSubAgentError('socket hang up')).toBe(true)
    expect(isTransientSubAgentError('fetch failed')).toBe(true)
    expect(isTransientSubAgentError('ECONNRESET')).toBe(true)
    expect(isTransientSubAgentError('ETIMEDOUT')).toBe(true)
    expect(isTransientSubAgentError('ENETUNREACH')).toBe(true)
    expect(isTransientSubAgentError('network error mid-stream')).toBe(true)
    expect(isTransientSubAgentError('Request timeout after 30s')).toBe(true)
  })

  it('rejects permanent / non-transient errors', () => {
    expect(isTransientSubAgentError('')).toBe(false)
    expect(isTransientSubAgentError('401 Unauthorized')).toBe(false)
    expect(isTransientSubAgentError('400 bad request: missing field')).toBe(false)
    expect(isTransientSubAgentError('schema validation failed: agent must be string')).toBe(false)
    expect(isTransientSubAgentError('model refused to comply')).toBe(false)
    expect(isTransientSubAgentError('cannot call self (claude-code)')).toBe(false)
    expect(isTransientSubAgentError('agent not found: foo')).toBe(false)
  })
})

describe('v1.2.139 — CallAgentOpts.planMode propagation', () => {
  beforeEach(() => { restoreEnv() })

  it('forwards opts.planMode=true to the target adapter sendPrompt() call', async () => {
    let captured: AgentSendOpts | null = null
    const fake: AgentAdapter = {
      name: 'test-fake-planmode',
      aliases: [],
      async isAvailable() { return true },
      async *sendPrompt(_sid, _prompt, _history, opts?: AgentSendOpts) {
        captured = opts ?? {}
        yield 'ok'
      },
    }
    registry.registerAgent(fake)
    // depth needs to be allowed; pin an explicit cap independent of the default.
    process.env.AGIM_A2A_MAX_DEPTH = '5'

    const r = await a2a.callAgentByName('test-fake-planmode', 'do nothing', fakeRouteCtx(), {
      planMode: true,
      callerAgent: 'native',
    })
    expect(r.ok).toBe(true)
    expect(captured).not.toBeNull()
    expect(captured!.planMode).toBe(true)
    // Sanity: the depth + parentJobId fields also got forwarded.
    expect(captured!.callDepth).toBe(1)
  })

  it('does NOT set planMode field when opts.planMode is undefined / false', async () => {
    let captured: AgentSendOpts | null = null
    const fake: AgentAdapter = {
      name: 'test-fake-no-planmode',
      aliases: [],
      async isAvailable() { return true },
      async *sendPrompt(_sid, _prompt, _history, opts?: AgentSendOpts) {
        captured = opts ?? {}
        yield 'ok'
      },
    }
    registry.registerAgent(fake)
    process.env.AGIM_A2A_MAX_DEPTH = '5'

    const r = await a2a.callAgentByName('test-fake-no-planmode', 'hi', fakeRouteCtx(), {
      callerAgent: 'native',
      // planMode omitted
    })
    expect(r.ok).toBe(true)
    expect(captured).not.toBeNull()
    // Field absent (we avoid stamping false so adapters' default behaviour stays unchanged).
    expect(captured!.planMode).toBeUndefined()
  })
})
