// Unit tests for the heartbeat service.
//
// Scope considerations: the SQLite-backed store gracefully no-ops when
// better-sqlite3's native binding isn't compiled (we observed this in
// the CI image). To keep tests deterministic regardless of binding
// state, we exercise the heartbeat *logic* with a synthetic HeartbeatRow
// passed directly to runForBinding(); the store integration is covered
// by the dedicated heartbeat-store tests when bindings are present.
//
// The two collaborators we DO mock here:
//   1. `globalThis.fetch` — to control the decide-phase LLM verdict
//   2. The agent registry / sessionManager — to deterministically pick
//      the "no agent available" path; testing the execute branch would
//      require a registered AgentAdapter mock which leaks lots of
//      sessionManager state. The 'no-agent' path is the most important
//      one to lock in anyway because that's what new deployments see
//      before they configure any CLI agent.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  runForBinding,
  startHeartbeatScheduler,
  stopHeartbeatScheduler,
  schedulerInfo,
} from './heartbeat.js'
import type { HeartbeatRow } from './heartbeat-store.js'
import { loadFromConfig, _resetRegistry } from './llm/index.js'
import { saveSecret, envKeyForBackend, LLM_SECRETS_PATH } from './llm/secrets.js'
import { existsSync, unlinkSync } from 'node:fs'

const ORIGINAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  'AGIM_HEARTBEAT_ENABLED',
  'AGIM_HEARTBEAT_TICK_INTERVAL_MS',
  'AGIM_NOTIFICATION_EVALUATOR',
  envKeyForBackend('cheap-mock'),
]

function clearAll(): void {
  for (const k of ENV_KEYS) delete process.env[k]
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  _resetRegistry()
  globalThis.fetch = ORIGINAL_FETCH
}

function mockDecideResponse(json: object): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(json) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
}

function configureCheapBackend(): void {
  saveSecret('cheap-mock', 'sk-test')
  loadFromConfig({
    llmBackends: [{
      name: 'cheap-mock', provider: 'openai-compat', model: 'gpt-4o-mini',
    }],
    llmRoles: { cheap: 'cheap-mock' },
  })
}

function makeRow(overrides: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return {
    id: 1,
    platform: 'wechat',
    channelId: 'rest',
    threadId: 'thread-1',
    userId: 'user-1',
    body: '- 每天 8:30 给我一句今日要点',
    intervalMinutes: 30,
    enabled: true,
    lastTickAt: null,
    lastStatus: 'pending',
    lastReason: '',
    lastTextPreview: '',
    createdAt: '2026-05-23T00:00:00Z',
    updatedAt: '2026-05-23T00:00:00Z',
    ...overrides,
  }
}

beforeEach(clearAll)
afterEach(clearAll)

describe('runForBinding — decide phase', () => {
  it('disabled row → skipped without LLM call', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const row = makeRow({ enabled: false })
    const result = await runForBinding(row)
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('disabled')
    expect(called).toBe(false)
  })

  it('decide=skip → skipped, no execute', async () => {
    configureCheapBackend()
    mockDecideResponse({ run: false, summary: '' })
    const result = await runForBinding(makeRow())
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('decide=skip')
  })

  it('no cheap backend configured → fail-open, then no-agent', async () => {
    // No `cheap` role wired → decide phase fail-opens to run=true.
    // Execute phase has no agent registered → no-agent status.
    const result = await runForBinding(makeRow())
    expect(result.status).toBe('no-agent')
    expect(result.reason).toMatch(/no agent/i)
  })

  it('decide parse fails → fail-open, then no-agent', async () => {
    configureCheapBackend()
    // Mock returns valid HTTP but unparseable verdict body.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'I think you should run it. Yes.' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    const result = await runForBinding(makeRow())
    // Decide fail-opens → execute → no agent registered → no-agent.
    expect(result.status).toBe('no-agent')
  })

  it('decide LLM HTTP error → fail-open, then no-agent', async () => {
    configureCheapBackend()
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const result = await runForBinding(makeRow())
    expect(result.status).toBe('no-agent')
  })
})

describe('heartbeat scheduler lifecycle', () => {
  afterEach(() => {
    stopHeartbeatScheduler()
  })

  it('does not arm an interval when AGIM_HEARTBEAT_ENABLED is unset', () => {
    startHeartbeatScheduler()
    expect(schedulerInfo()).toEqual({
      enabled: false,
      running: false,
      periodMs: 60_000,
    })
  })

  it('starts and stops when enabled', () => {
    process.env.AGIM_HEARTBEAT_ENABLED = '1'
    process.env.AGIM_HEARTBEAT_TICK_INTERVAL_MS = '5000'
    startHeartbeatScheduler()
    expect(schedulerInfo()).toEqual({
      enabled: true,
      running: true,
      periodMs: 5000,
    })
    stopHeartbeatScheduler()
    expect(schedulerInfo().running).toBe(false)
    expect(schedulerInfo().enabled).toBe(true)
  })

  it('is idempotent on start', () => {
    process.env.AGIM_HEARTBEAT_ENABLED = '1'
    startHeartbeatScheduler()
    startHeartbeatScheduler()
    expect(schedulerInfo().running).toBe(true)
    stopHeartbeatScheduler()
    expect(schedulerInfo().running).toBe(false)
  })
})
