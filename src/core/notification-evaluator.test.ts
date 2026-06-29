// Unit tests for notification-evaluator.
//
// Strategy: stub out the LLM registry's tryIntrospect by configuring a
// real OpenAICompatProvider against a mocked global fetch. That keeps
// the test exercising the registry + secrets + tryIntrospect plumbing
// end-to-end, which is the real risk surface (the parser is trivial).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { evaluateNotification } from './notification-evaluator.js'
import { loadFromConfig, _resetRegistry } from './llm/index.js'
import { saveSecret, envKeyForBackend, LLM_SECRETS_PATH } from './llm/secrets.js'
import { existsSync, unlinkSync } from 'node:fs'

const ORIGINAL_FETCH = globalThis.fetch
const ENV_KEYS = [
  'AGIM_NOTIFICATION_EVALUATOR',
  'AGIM_NOTIFICATION_EVALUATOR_SOURCES',
  envKeyForBackend('evaluator-cheap'),
]

function clearAll(): void {
  for (const k of ENV_KEYS) delete process.env[k]
  if (existsSync(LLM_SECRETS_PATH)) unlinkSync(LLM_SECRETS_PATH)
  _resetRegistry()
  globalThis.fetch = ORIGINAL_FETCH
}

function mockChat(responseText: string, status = 200): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: responseText }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
}

function configureBackend(): void {
  saveSecret('evaluator-cheap', 'sk-test')
  loadFromConfig({
    llmBackends: [{
      name: 'evaluator-cheap',
      provider: 'openai-compat',
      model: 'gpt-4.1-mini',
    }],
    llmRoles: { evaluator: 'evaluator-cheap' },
  })
}

beforeEach(clearAll)
afterEach(clearAll)

describe('evaluateNotification — disabled paths', () => {
  it('default off: every input is delivered with via=disabled', async () => {
    const v = await evaluateNotification({
      source: 'push',
      text: 'anything',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    expect(v.via).toBe('disabled')
  })

  it('source not in gated set: via=source-excluded', async () => {
    process.env.AGIM_NOTIFICATION_EVALUATOR = 'on'
    // Default gated = {push, heartbeat}; 'notify' is excluded.
    const v = await evaluateNotification({
      source: 'notify',
      text: 'webhook fire',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    expect(v.via).toBe('source-excluded')
  })

  it('empty text returns via=fail-open (no LLM call)', async () => {
    process.env.AGIM_NOTIFICATION_EVALUATOR = 'on'
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    const v = await evaluateNotification({
      source: 'push',
      text: '   ',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    expect(v.via).toBe('fail-open')
    expect(called).toBe(false)
  })

  it('no evaluator backend configured: via=no-backend', async () => {
    process.env.AGIM_NOTIFICATION_EVALUATOR = 'on'
    // Registry has no provider for 'evaluator' role.
    loadFromConfig({})
    const v = await evaluateNotification({
      source: 'push',
      text: 'hello',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    expect(v.via).toBe('no-backend')
  })
})

describe('evaluateNotification — verdict paths', () => {
  beforeEach(() => {
    process.env.AGIM_NOTIFICATION_EVALUATOR = 'on'
    configureBackend()
  })

  it('LLM says deliver:true → shouldDeliver=true, via=evaluator', async () => {
    mockChat('{"deliver": true, "reason": "alert about price"}')
    const v = await evaluateNotification({
      source: 'push',
      text: '600519 涨停了',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    expect(v.via).toBe('evaluator')
    expect(v.reason).toContain('price')
  })

  it('LLM says deliver:false → shouldDeliver=false, via=evaluator', async () => {
    mockChat('{"deliver": false, "reason": "routine ack"}')
    const v = await evaluateNotification({
      source: 'push',
      text: '好的，已经完成了',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(false)
    expect(v.via).toBe('evaluator')
    expect(v.reason).toContain('routine')
  })

  it('LLM returns gibberish → fail-open delivery', async () => {
    mockChat('I think you should deliver this. Yes.')
    const v = await evaluateNotification({
      source: 'push',
      text: 'something',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    expect(v.via).toBe('fail-open')
  })

  it('LLM returns markdown-fenced JSON → still parses', async () => {
    mockChat('```json\n{"deliver": false, "reason": "no value"}\n```')
    const v = await evaluateNotification({
      source: 'push',
      text: 'x',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(false)
    expect(v.via).toBe('evaluator')
  })

  it('LLM HTTP failure → fail-open delivery', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const v = await evaluateNotification({
      source: 'push',
      text: 'something',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    // tryIntrospect catches the LlmProviderError and returns null →
    // evaluator sees no-backend-or-call-failed.
    expect(v.via).toBe('no-backend')
  })

  it('custom AGIM_NOTIFICATION_EVALUATOR_SOURCES extends the set', async () => {
    process.env.AGIM_NOTIFICATION_EVALUATOR_SOURCES = 'notify,push'
    mockChat('{"deliver": false, "reason": "spam"}')
    const v = await evaluateNotification({
      source: 'notify',  // now gated
      text: 'cron tick: nothing changed',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(false)
    expect(v.via).toBe('evaluator')
  })

  it('AGIM_NOTIFICATION_EVALUATOR_SOURCES can shrink the set', async () => {
    // Only 'heartbeat' gated → 'push' becomes excluded.
    process.env.AGIM_NOTIFICATION_EVALUATOR_SOURCES = 'heartbeat'
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const v = await evaluateNotification({
      source: 'push',
      text: 'whatever',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(true)
    expect(v.via).toBe('source-excluded')
    expect(called).toBe(false)
  })

  it('verdict.reason length is clamped to 200 chars', async () => {
    const longReason = 'r'.repeat(500)
    mockChat(`{"deliver": false, "reason": "${longReason}"}`)
    const v = await evaluateNotification({
      source: 'push',
      text: 'x',
      targetThread: 'wechat:rest:thread-1',
    })
    expect(v.shouldDeliver).toBe(false)
    expect(v.reason.length).toBeLessThanOrEqual(200)
  })
})
