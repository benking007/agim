// Unit tests for formatAge — bounds + input shapes (P0 #4).

import { describe, it, expect } from 'bun:test'
import { formatAge } from './format-age.js'

const NOW = Date.parse('2026-05-23T10:00:00Z')
const ms = (offsetMs: number) => NOW - offsetMs

const SEC = 1_000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatAge — bucket selection', () => {
  it('< 60s → "just now"', () => {
    expect(formatAge(ms(0), NOW)).toBe('just now')
    expect(formatAge(ms(30 * SEC), NOW)).toBe('just now')
    expect(formatAge(ms(59 * SEC), NOW)).toBe('just now')
  })

  it('60s..59min → "Nmin ago"', () => {
    expect(formatAge(ms(60 * SEC), NOW)).toBe('1min ago')
    expect(formatAge(ms(5 * MIN), NOW)).toBe('5min ago')
    expect(formatAge(ms(59 * MIN), NOW)).toBe('59min ago')
  })

  it('60min..23h → "Nh ago"', () => {
    expect(formatAge(ms(HOUR), NOW)).toBe('1h ago')
    expect(formatAge(ms(12 * HOUR), NOW)).toBe('12h ago')
    expect(formatAge(ms(23 * HOUR + 59 * MIN), NOW)).toBe('23h ago')
  })

  it('24h..29d → "Nd ago"', () => {
    expect(formatAge(ms(DAY), NOW)).toBe('1d ago')
    expect(formatAge(ms(7 * DAY), NOW)).toBe('7d ago')
    expect(formatAge(ms(29 * DAY), NOW)).toBe('29d ago')
  })

  it('30d..11mo → "Nmo ago"', () => {
    expect(formatAge(ms(30 * DAY), NOW)).toBe('1mo ago')
    expect(formatAge(ms(180 * DAY), NOW)).toBe('6mo ago')
    expect(formatAge(ms(360 * DAY), NOW)).toBe('12mo ago')
  })

  it('≥ 365d → "Ny ago"', () => {
    expect(formatAge(ms(365 * DAY), NOW)).toBe('1y ago')
    expect(formatAge(ms(730 * DAY), NOW)).toBe('2y ago')
  })
})

describe('formatAge — input shape coercion', () => {
  it('accepts epoch seconds (heuristic upscaled)', () => {
    const tenMinutesAgoSec = Math.floor((NOW - 10 * MIN) / 1000)
    expect(formatAge(tenMinutesAgoSec, NOW)).toBe('10min ago')
  })

  it('accepts epoch milliseconds', () => {
    expect(formatAge(NOW - 10 * MIN, NOW)).toBe('10min ago')
  })

  it('accepts ISO string', () => {
    expect(formatAge(new Date(NOW - HOUR).toISOString(), NOW)).toBe('1h ago')
  })

  it('accepts Date object', () => {
    expect(formatAge(new Date(NOW - DAY), NOW)).toBe('1d ago')
  })

  it('returns "unknown" for null / undefined / 0 / NaN / malformed', () => {
    expect(formatAge(null, NOW)).toBe('unknown')
    expect(formatAge(undefined, NOW)).toBe('unknown')
    expect(formatAge(0, NOW)).toBe('unknown')
    expect(formatAge(NaN, NOW)).toBe('unknown')
    expect(formatAge('not-a-date', NOW)).toBe('unknown')
  })

  it('clamps future-dated input (clock skew) to "just now"', () => {
    expect(formatAge(NOW + 30 * SEC, NOW)).toBe('just now')
    expect(formatAge(NOW + 5 * MIN, NOW)).toBe('just now')
  })
})
