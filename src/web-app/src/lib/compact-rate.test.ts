import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACT_AT_TOKENS,
  effectiveCompactLineForRate,
  hardLineForCompactRate,
} from './compact-rate'

describe('compact-rate effective line', () => {
  it('caps 1M frequent hard line with absolute 200k', () => {
    const hard = hardLineForCompactRate(1_000_000, 'frequent')
    expect(hard).toBeGreaterThan(700_000)
    expect(effectiveCompactLineForRate(1_000_000, 'frequent')).toBe(DEFAULT_COMPACT_AT_TOKENS)
    expect(effectiveCompactLineForRate(1_000_000, 'frequent', 0)).toBe(hard)
  })

  it('keeps small-window hard line when absolute is higher', () => {
    const hard = hardLineForCompactRate(128_000, 'auto')
    expect(effectiveCompactLineForRate(128_000, 'auto')).toBe(hard)
  })
})
