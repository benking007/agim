// Unit tests for the built-in dispatcher.

import { describe, it, expect, afterEach } from 'bun:test'
import {
  buildBuiltinDispatcher,
  getBuiltinTools,
  isBuiltinToolName,
} from './builtin-dispatcher.js'
import type { ToolCallRequest } from './provider-base.js'

const TZ_KEY = 'AGIM_TZ_OFFSET_HOURS'

afterEach(() => { delete process.env[TZ_KEY] })

function call(name: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return { id: 'c', name, arguments: args }
}

describe('builtin-dispatcher — tool roster', () => {
  it('getBuiltinTools includes the four documented tools', () => {
    const names = getBuiltinTools().map((t) => t.name)
    expect(names).toEqual([
      'agim_echo',
      'agim_now',
      'agim_sleep_ms',
      'agim_random_uuid',
    ])
  })

  it('isBuiltinToolName recognises every advertised name and rejects others', () => {
    for (const t of getBuiltinTools()) {
      expect(isBuiltinToolName(t.name)).toBe(true)
    }
    expect(isBuiltinToolName('mcp_filesystem_read_file')).toBe(false)
    expect(isBuiltinToolName('native_unknown')).toBe(false)
  })

  it('accepts legacy native_* aliases for dispatch recognition', () => {
    expect(isBuiltinToolName('native_echo')).toBe(true)
    expect(isBuiltinToolName('native_now')).toBe(true)
  })

  it('dispatches legacy native_echo to the same handler', async () => {
    const d = buildBuiltinDispatcher()
    const r = await d(call('native_echo', { text: 'hi' }), new AbortController().signal)
    expect(r.isError).toBe(false)
    expect(r.text).toBe('hi')
  })

  it('every tool def declares an object schema', () => {
    for (const t of getBuiltinTools()) {
      expect(t.parameters.type).toBe('object')
    }
  })
})

describe('builtin-dispatcher — execution', () => {
  const signal = new AbortController().signal
  const dispatch = buildBuiltinDispatcher()

  it('agim_echo returns the text argument verbatim, isError=false, source=builtin', async () => {
    const r = await dispatch(call('agim_echo', { text: 'hello world' }), signal)
    expect(r.text).toBe('hello world')
    expect(r.isError).toBe(false)
    expect(r.source).toBe('builtin')
  })

  it('agim_echo with non-string text falls back to empty', async () => {
    const r = await dispatch(call('agim_echo', { text: 42 }), signal)
    expect(r.text).toBe('')
    expect(r.isError).toBe(false)
  })

  it('agim_now returns JSON with utc/local/offset keys', async () => {
    const r = await dispatch(call('agim_now'), signal)
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.text) as { utc: string; local: string; offset: string }
    expect(parsed.utc).toMatch(/Z$/)
    expect(parsed.local).not.toMatch(/Z$/)
    expect(parsed.offset).toMatch(/^UTC[+-]\d{2}:\d{2}$/)
  })

  it('agim_now respects AGIM_TZ_OFFSET_HOURS', async () => {
    process.env[TZ_KEY] = '0'
    const r = await dispatch(call('agim_now'), signal)
    const parsed = JSON.parse(r.text) as { offset: string }
    expect(parsed.offset).toBe('UTC+00:00')
  })

  it('agim_sleep_ms sleeps and clamps to MAX_SLEEP_MS', async () => {
    const t0 = Date.now()
    const r = await dispatch(call('agim_sleep_ms', { ms: 60_000 }), signal)
    const dt = Date.now() - t0
    expect(r.isError).toBe(false)
    expect(r.text).toContain('5000ms')
    // Should be ~5s; allow generous slack for CI scheduler jitter.
    expect(dt).toBeGreaterThanOrEqual(4_900)
    expect(dt).toBeLessThan(7_500)
  }, 10_000)

  it('agim_sleep_ms validates ms is numeric', async () => {
    const r = await dispatch(call('agim_sleep_ms', { ms: 'soon' }), signal)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('number')
  })

  it('agim_sleep_ms aborts via signal', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new Error('cancel')), 50)
    const r = await dispatch(call('agim_sleep_ms', { ms: 1_000 }), ctrl.signal)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/aborted/i)
  })

  it('agim_random_uuid returns a v4 UUID format', async () => {
    const r = await dispatch(call('agim_random_uuid'), signal)
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('unknown name returns source=unknown for combineDispatchers fall-through', async () => {
    const r = await dispatch(call('native_does_not_exist'), signal)
    expect(r.isError).toBe(true)
    expect(r.source).toBe('unknown')
    expect(r.text).toContain('not in builtin set')
  })
})
