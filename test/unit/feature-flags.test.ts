// Compliance feature flags — see src/core/feature-flags.ts.
//
// Both flags default OFF (strict-1 matching) so an unset env, an
// accidentally truthy-ish value like "true" / "yes", or a 0 produce
// the same result: hidden. Only the exact string '1' opts in.

import { describe, it, expect, afterEach } from 'bun:test'
import { isGlobalImEnabled, isRemoteAgentEnabled } from '../../src/core/feature-flags'

const KEYS = ['AGIM_ENABLE_GLOBAL_IM', 'AGIM_ENABLE_REMOTE_AGENT']

afterEach(() => {
  for (const k of KEYS) delete process.env[k]
})

describe('isGlobalImEnabled', () => {
  it('returns false when the env var is unset', () => {
    delete process.env.AGIM_ENABLE_GLOBAL_IM
    expect(isGlobalImEnabled()).toBe(false)
  })

  it('returns true only when set to the exact string "1"', () => {
    process.env.AGIM_ENABLE_GLOBAL_IM = '1'
    expect(isGlobalImEnabled()).toBe(true)
  })

  it('does NOT accept truthy-ish values (compliance-strict)', () => {
    for (const v of ['true', 'yes', 'on', 'TRUE', '0', '', '2', ' 1 ']) {
      process.env.AGIM_ENABLE_GLOBAL_IM = v
      expect(isGlobalImEnabled()).toBe(false)
    }
  })
})

describe('isRemoteAgentEnabled', () => {
  it('returns false when the env var is unset', () => {
    delete process.env.AGIM_ENABLE_REMOTE_AGENT
    expect(isRemoteAgentEnabled()).toBe(false)
  })

  it('returns true only when set to the exact string "1"', () => {
    process.env.AGIM_ENABLE_REMOTE_AGENT = '1'
    expect(isRemoteAgentEnabled()).toBe(true)
  })

  it('does NOT accept truthy-ish values (compliance-strict)', () => {
    for (const v of ['true', 'yes', 'on', '0', '']) {
      process.env.AGIM_ENABLE_REMOTE_AGENT = v
      expect(isRemoteAgentEnabled()).toBe(false)
    }
  })
})

describe('the two flags are independent', () => {
  it('global-IM on does not enable remote-agent', () => {
    process.env.AGIM_ENABLE_GLOBAL_IM = '1'
    delete process.env.AGIM_ENABLE_REMOTE_AGENT
    expect(isGlobalImEnabled()).toBe(true)
    expect(isRemoteAgentEnabled()).toBe(false)
  })
  it('remote-agent on does not enable global-IM', () => {
    delete process.env.AGIM_ENABLE_GLOBAL_IM
    process.env.AGIM_ENABLE_REMOTE_AGENT = '1'
    expect(isGlobalImEnabled()).toBe(false)
    expect(isRemoteAgentEnabled()).toBe(true)
  })
})
