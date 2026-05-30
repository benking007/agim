// v1.2.108 — locks the upgraded stuck-loop detector logic. v1.2.95 used
// (name + isError + preview[0..200]), which let the model slip past
// trivial output variation (timestamps, counters, byte length deltas).
// v1.2.108 keys on (name + argsKey + errorType) so we detect "model
// trying the same call 3 times in a row" regardless of result jitter.

import { describe, it, expect } from 'bun:test'
import {
  stableStringify,
  extractErrorType,
  isStuckLoop,
} from '../../src/core/llm/agent-loop.js'

describe('stableStringify', () => {
  it('primitives round-trip via JSON.stringify', () => {
    expect(stableStringify('a')).toBe('"a"')
    expect(stableStringify(42)).toBe('42')
    expect(stableStringify(true)).toBe('true')
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(undefined)).toBe('null')
  })

  it('sorts object keys at every level', () => {
    const a = stableStringify({ b: 1, a: 2 })
    const b = stableStringify({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  it('sorts nested keys too', () => {
    const a = stableStringify({ outer: { z: 1, a: 2 }, first: true })
    const b = stableStringify({ first: true, outer: { a: 2, z: 1 } })
    expect(a).toBe(b)
  })

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
    expect(stableStringify([3, 1, 2])).not.toBe(stableStringify([1, 2, 3]))
  })

  it('tolerates circular references without throwing', () => {
    const o: Record<string, unknown> = { a: 1 }
    o.self = o
    const s = stableStringify(o)
    expect(s).toContain('"[circular]"')
  })

  it('collapses functions to a placeholder', () => {
    expect(stableStringify({ fn: () => 1, x: 2 })).toBe('{"fn":"[fn]","x":2}')
  })
})

describe('extractErrorType', () => {
  it('non-error returns empty string', () => {
    expect(extractErrorType(false, 'anything here')).toBe('')
  })

  it('first non-empty line on error', () => {
    expect(extractErrorType(true, 'ENOENT: no such file\nstack trace…')).toBe(
      'ENOENT: no such file',
    )
  })

  it('skips leading blank lines', () => {
    expect(extractErrorType(true, '\n\n  hit the wall\nmore')).toBe('hit the wall')
  })

  it('truncates to 80 chars', () => {
    const longLine = 'a'.repeat(200)
    expect(extractErrorType(true, longLine).length).toBe(80)
  })
})

describe('isStuckLoop', () => {
  const mk = (name: string, argsKey: string, errorType = ''): {
    name: string; argsKey: string; errorType: string
  } => ({ name, argsKey, errorType })

  it('< 3 entries → never stuck', () => {
    expect(isStuckLoop([])).toBe(false)
    expect(isStuckLoop([mk('a', 'k')])).toBe(false)
    expect(isStuckLoop([mk('a', 'k'), mk('a', 'k')])).toBe(false)
  })

  it('3 identical (name + argsKey + errorType) → stuck', () => {
    const r = [mk('fs_read', '{"path":"a"}'), mk('fs_read', '{"path":"a"}'), mk('fs_read', '{"path":"a"}')]
    expect(isStuckLoop(r)).toBe(true)
  })

  it('different argsKey defeats the strike (model is exploring)', () => {
    const r = [
      mk('fs_read', '{"path":"a"}'),
      mk('fs_read', '{"path":"a"}'),
      mk('fs_read', '{"path":"b"}'),
    ]
    expect(isStuckLoop(r)).toBe(false)
  })

  it('different errorType defeats the strike', () => {
    const r = [
      mk('fs_read', '{"path":"a"}', 'ENOENT'),
      mk('fs_read', '{"path":"a"}', 'ENOENT'),
      mk('fs_read', '{"path":"a"}', 'EACCES'),
    ]
    expect(isStuckLoop(r)).toBe(false)
  })

  it('same args + flipping success/error → not stuck', () => {
    const r = [
      mk('http_get', '{"url":"x"}', ''),       // success
      mk('http_get', '{"url":"x"}', 'timeout'), // failure
      mk('http_get', '{"url":"x"}', ''),       // success
    ]
    expect(isStuckLoop(r)).toBe(false)
  })

  it('only the LAST 3 matter — earlier entries ignored', () => {
    const r = [
      mk('fs_read', '{"path":"a"}'),
      mk('fs_read', '{"path":"a"}'),
      mk('http_get', '{"url":"x"}'),
      mk('http_get', '{"url":"x"}'),
      mk('http_get', '{"url":"x"}'),
    ]
    expect(isStuckLoop(r)).toBe(true)
  })

  it('regression: result-text jitter no longer hides a stuck loop', () => {
    // v1.2.95 keyed on preview[0..200]; if the model's tool produced
    // slightly different bytes each time (timestamp, counter) the
    // strike was missed. v1.2.108 keys on args + error fingerprint,
    // both of which are stable — so this case now triggers.
    const r = [
      mk('exec', '{"cmd":"date"}', ''),
      mk('exec', '{"cmd":"date"}', ''),
      mk('exec', '{"cmd":"date"}', ''),
    ]
    expect(isStuckLoop(r)).toBe(true)
  })
})
