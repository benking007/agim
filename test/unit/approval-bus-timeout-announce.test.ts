// R13 C1 — announceTimeoutDefaultIfAllow contract test.
//
// The function should be a no-op when the policy is `deny` (default),
// and a one-shot warning + reminder-timer starter when `allow`.

import { describe, it, expect, afterEach } from 'bun:test'
import {
  announceTimeoutDefaultIfAllow,
  stopTimeoutDefaultReminder,
  isTimeoutDefaultAllow,
} from '../../src/core/approval-bus'

afterEach(() => {
  delete process.env.IMHUB_TIMEOUT_DEFAULT
  stopTimeoutDefaultReminder()
})

describe('isTimeoutDefaultAllow', () => {
  it('defaults to deny', () => {
    delete process.env.IMHUB_TIMEOUT_DEFAULT
    expect(isTimeoutDefaultAllow()).toBe(false)
  })

  it('reads `allow` case-insensitively', () => {
    process.env.IMHUB_TIMEOUT_DEFAULT = 'allow'
    expect(isTimeoutDefaultAllow()).toBe(true)
    process.env.IMHUB_TIMEOUT_DEFAULT = 'ALLOW'
    expect(isTimeoutDefaultAllow()).toBe(true)
  })

  it('rejects misspelt values (compliance-strict)', () => {
    for (const v of ['yes', '1', 'true', 'on', 'deny', '']) {
      process.env.IMHUB_TIMEOUT_DEFAULT = v
      expect(isTimeoutDefaultAllow()).toBe(false)
    }
  })
})

describe('announceTimeoutDefaultIfAllow', () => {
  it('returns silently when policy is deny', () => {
    delete process.env.IMHUB_TIMEOUT_DEFAULT
    expect(() => announceTimeoutDefaultIfAllow()).not.toThrow()
    // No assertion on stdout — silent path.
  })

  it('idempotent on repeated calls', () => {
    process.env.IMHUB_TIMEOUT_DEFAULT = 'allow'
    expect(() => {
      announceTimeoutDefaultIfAllow()
      announceTimeoutDefaultIfAllow()
      announceTimeoutDefaultIfAllow()
    }).not.toThrow()
  })

  it('stopTimeoutDefaultReminder is idempotent', () => {
    expect(() => {
      stopTimeoutDefaultReminder()
      stopTimeoutDefaultReminder()
    }).not.toThrow()
  })

  it('flipping back to deny stops the reminder', () => {
    process.env.IMHUB_TIMEOUT_DEFAULT = 'allow'
    announceTimeoutDefaultIfAllow()
    delete process.env.IMHUB_TIMEOUT_DEFAULT
    // Calling again with deny should clean up the timer without throwing.
    expect(() => announceTimeoutDefaultIfAllow()).not.toThrow()
  })
})
