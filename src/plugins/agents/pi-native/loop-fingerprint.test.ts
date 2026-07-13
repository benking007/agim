import { describe, expect, it } from 'bun:test'
import {
  failureSignature,
  normalizeErrorFingerprint,
  stableStringify,
} from './loop-fingerprint.js'

describe('pi-native loop fingerprints', () => {
  it('canonicalizes nested object key order', () => {
    expect(stableStringify({ a: 1, nested: { x: 2, y: 3 } })).toBe(
      stableStringify({ nested: { y: 3, x: 2 }, a: 1 }),
    )
  })

  it('normalizes volatile ids and timestamps but preserves HTTP status', () => {
    const a = normalizeErrorFingerprint(
      'HTTP 503 request 123456789 failed at 2026-07-13T08:00:01.000Z id 123e4567-e89b-12d3-a456-426614174000',
    )
    const b = normalizeErrorFingerprint(
      'HTTP 503 request 987654321 failed at 2026-07-13T08:00:59.000Z id 987e6543-e21b-12d3-a456-426614174999',
    )
    expect(a).toBe(b)
    expect(a).toContain('503')
    expect(normalizeErrorFingerprint('HTTP 404 failed')).not.toBe(normalizeErrorFingerprint('HTTP 503 failed'))
  })

  it('builds the same failure signature for reordered equivalent args', () => {
    expect(failureSignature('lookup', { query: 'x', limit: 5 }, 'upstream 503')).toBe(
      failureSignature('lookup', { limit: 5, query: 'x' }, 'upstream 503'),
    )
  })
})
