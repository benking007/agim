import { describe, expect, it } from 'vitest'

import {
  formatPointsCompact,
  monthDayLabel,
  sparklineLayout,
} from './points-chart'

describe('formatPointsCompact', () => {
  it('keeps small integers and compact larger values', () => {
    expect(formatPointsCompact(0)).toBe('0')
    expect(formatPointsCompact(9999)).toBe('9999')
    expect(formatPointsCompact(10_000)).toBe('10k')
    expect(formatPointsCompact(12_500)).toBe('12.5k')
    expect(formatPointsCompact(-40)).toBe('-40')
    expect(formatPointsCompact(2_000_000)).toBe('2.0M')
  })
})

describe('monthDayLabel', () => {
  it('formats ISO dates as M/D', () => {
    expect(monthDayLabel('2026-08-25')).toBe('8/25')
    expect(monthDayLabel('2026-01-03')).toBe('1/3')
  })
})

describe('sparklineLayout', () => {
  it('builds a line and closed area for daily spend', () => {
    const layout = sparklineLayout([0, 40, 15], 100, 50, 0, 0)
    expect(layout.max).toBe(40)
    expect(layout.line.startsWith('M')).toBe(true)
    expect(layout.line).toContain(' L')
    expect(layout.area.endsWith(' Z')).toBe(true)
  })

  it('returns empty paths when there are no days', () => {
    const layout = sparklineLayout([])
    expect(layout.line).toBe('')
    expect(layout.area).toBe('')
  })
})
