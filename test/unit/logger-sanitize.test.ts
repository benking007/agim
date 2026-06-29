// sanitizeUserText — security hardening item #1
//
// Locks the contract that user-message logging produces only safe
// fields (length + 6-char prefix + 12-char sha256 hash). Verbatim
// text only appears when the operator explicitly sets
// AGIM_LOG_USER_TEXT=1.

import { describe, it, expect, afterEach } from 'bun:test'
import { sanitizeUserText } from '../../src/core/logger'

const ENV_KEY = 'AGIM_LOG_USER_TEXT'

describe('sanitizeUserText', () => {
  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('returns length + short prefix + 12-hex hash by default', () => {
    const out = sanitizeUserText('hello world this is a long message')
    expect(out.len).toBe(34)
    expect(out.prefix).toBe('hello ')
    expect(out.hash).toMatch(/^[a-f0-9]{12}$/)
    expect(out.text).toBeUndefined()
  })

  it('hash is stable for the same input (correlation across log lines)', () => {
    const a = sanitizeUserText('the operator pasted a real secret')
    const b = sanitizeUserText('the operator pasted a real secret')
    expect(a.hash).toBe(b.hash)
  })

  it('hash differs for different inputs', () => {
    const a = sanitizeUserText('secret one')
    const b = sanitizeUserText('secret two')
    expect(a.hash).not.toBe(b.hash)
  })

  it('handles empty string without throwing', () => {
    const out = sanitizeUserText('')
    expect(out.len).toBe(0)
    expect(out.prefix).toBe('')
    expect(out.hash).toMatch(/^[a-f0-9]{12}$/) // sha256('') still hashes
  })

  it('coerces non-string input to string', () => {
    // Defensive — historically text could be undefined / null in edge
    // paths (parseMessage returning empty / agent reply being a number).
    // We treat as empty rather than throw.
    const out = sanitizeUserText(undefined as unknown as string)
    expect(out.len).toBe(0)
    expect(out.prefix).toBe('')
  })

  it('AGIM_LOG_USER_TEXT=1 escape hatch surfaces verbatim text', () => {
    process.env[ENV_KEY] = '1'
    const out = sanitizeUserText('secret content here')
    expect(out.text).toBe('secret content here')
  })

  it('escape hatch still caps at 120 chars (overflow guardrail)', () => {
    process.env[ENV_KEY] = '1'
    const big = 'x'.repeat(500)
    const out = sanitizeUserText(big)
    expect(out.text).toHaveLength(120)
  })

  it('AGIM_LOG_USER_TEXT not set → no `text` field', () => {
    delete process.env[ENV_KEY]
    const out = sanitizeUserText('whatever')
    expect(out.text).toBeUndefined()
  })

  it('non-"1" value does NOT enable verbatim text', () => {
    // Strict — only `1` opts in. true / yes / on do nothing.
    for (const v of ['true', 'yes', 'on', 'TRUE', '0', '']) {
      process.env[ENV_KEY] = v
      const out = sanitizeUserText('secret')
      expect(out.text).toBeUndefined()
    }
  })
})
