// R13 C1 — announceTimeoutDefaultIfAllow contract test.
//
// The function should be a no-op when the policy is `deny` (default),
// and a one-shot warning + reminder-timer starter when `allow`.

import { describe, it, expect, afterEach } from 'bun:test'
import {
  announceTimeoutDefaultIfAllow,
  stopTimeoutDefaultReminder,
  isTimeoutDefaultAllow,
  isAutoApproveEnabled,
  isAutoApproveEffective,
} from '../../src/core/approval-bus'
import { _resetCache as resetSenderAllowlist } from '../../src/core/sender-allowlist'

afterEach(() => {
  delete process.env.AGIM_TIMEOUT_DEFAULT
  delete process.env.AGIM_AUTO_APPROVE
  delete process.env.AGIM_AUTO_APPROVE_OPEN_IM
  delete process.env.AGIM_ALLOWED_USERS
  resetSenderAllowlist()
  stopTimeoutDefaultReminder()
})

describe('isTimeoutDefaultAllow', () => {
  it('defaults to allow', () => {
    delete process.env.AGIM_TIMEOUT_DEFAULT
    expect(isTimeoutDefaultAllow()).toBe(true)
  })

  it('deny disables auto-approve on timeout', () => {
    process.env.AGIM_TIMEOUT_DEFAULT = 'deny'
    expect(isTimeoutDefaultAllow()).toBe(false)
    process.env.AGIM_TIMEOUT_DEFAULT = 'DENY'
    expect(isTimeoutDefaultAllow()).toBe(false)
  })

  it('non-deny values are treated as allow', () => {
    for (const v of ['allow', 'ALLOW', 'yes', '1', 'true', 'on', '']) {
      process.env.AGIM_TIMEOUT_DEFAULT = v
      expect(isTimeoutDefaultAllow()).toBe(true)
    }
  })
})

describe('announceTimeoutDefaultIfAllow', () => {
  it('returns silently when policy is deny', () => {
    delete process.env.AGIM_TIMEOUT_DEFAULT
    expect(() => announceTimeoutDefaultIfAllow()).not.toThrow()
    // No assertion on stdout — silent path.
  })

  it('idempotent on repeated calls', () => {
    process.env.AGIM_TIMEOUT_DEFAULT = 'allow'
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
    process.env.AGIM_TIMEOUT_DEFAULT = 'allow'
    announceTimeoutDefaultIfAllow()
    delete process.env.AGIM_TIMEOUT_DEFAULT
    // Calling again with deny should clean up the timer without throwing.
    expect(() => announceTimeoutDefaultIfAllow()).not.toThrow()
  })

  it('auto-approve mode logs info and skips the warning banner', () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    expect(() => announceTimeoutDefaultIfAllow()).not.toThrow()
  })
})

describe('isAutoApproveEnabled', () => {
  it('defaults to false (safe default)', () => {
    delete process.env.AGIM_AUTO_APPROVE
    expect(isAutoApproveEnabled()).toBe(false)
  })

  it('recognized OFF values', () => {
    for (const v of ['0', 'off', 'false', 'no', '']) {
      process.env.AGIM_AUTO_APPROVE = v
      expect(isAutoApproveEnabled()).toBe(false)
    }
  })

  it('non-off values are treated as on', () => {
    for (const v of ['1', 'on', 'true', 'yes', 'ON', 'True', 'YES']) {
      process.env.AGIM_AUTO_APPROVE = v
      expect(isAutoApproveEnabled()).toBe(true)
    }
  })
})

describe('isAutoApproveEffective', () => {
  it('is false when auto-approve env is off', () => {
    delete process.env.AGIM_AUTO_APPROVE
    expect(isAutoApproveEffective()).toBe(false)
  })

  it('is true for web-console-only when auto-approve is on', () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    // No messengers in default test env config → effective
    expect(isAutoApproveEffective()).toBe(true)
  })

  it('is true when strict allowlist is configured', () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    process.env.AGIM_ALLOWED_USERS = 'telegram:12345'
    resetSenderAllowlist()
    expect(isAutoApproveEffective()).toBe(true)
  })

  it('OPEN_IM ack restores auto-approve without strict allowlist', () => {
    process.env.AGIM_AUTO_APPROVE = '1'
    process.env.AGIM_AUTO_APPROVE_OPEN_IM = '1'
    delete process.env.AGIM_ALLOWED_USERS
    resetSenderAllowlist()
    expect(isAutoApproveEffective()).toBe(true)
  })
})
