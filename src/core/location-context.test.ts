// location-context.test.ts — TTL cache + annotation formatting.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  setLocationContext,
  consumeLocationContext,
  formatLocationAnnotation,
  _clearForTest,
  _sizeForTest,
} from './location-context.js'

const TK = 'telegram:default:42'

beforeEach(() => { _clearForTest() })

describe('location-context store', () => {
  it('set + consume round-trip', () => {
    setLocationContext(TK, { lat: 30.27, lng: 120.12, accuracy: 5 })
    const c = consumeLocationContext(TK)
    expect(c?.lat).toBe(30.27)
    expect(c?.lng).toBe(120.12)
    expect(c?.accuracy).toBe(5)
  })

  it('consume is single-shot — second call returns null', () => {
    setLocationContext(TK, { lat: 1, lng: 2 })
    consumeLocationContext(TK)
    expect(consumeLocationContext(TK)).toBeNull()
    expect(_sizeForTest()).toBe(0)
  })

  it('returns null when nothing pending', () => {
    expect(consumeLocationContext(TK)).toBeNull()
  })

  it('set overwrites prior entry for the same thread', () => {
    setLocationContext(TK, { lat: 1, lng: 2 })
    setLocationContext(TK, { lat: 3, lng: 4 })
    expect(consumeLocationContext(TK)?.lat).toBe(3)
  })

  it('different threads are independent', () => {
    setLocationContext(TK, { lat: 1, lng: 2 })
    setLocationContext('telegram:default:99', { lat: 9, lng: 9 })
    expect(_sizeForTest()).toBe(2)
    expect(consumeLocationContext(TK)?.lat).toBe(1)
    expect(consumeLocationContext('telegram:default:99')?.lat).toBe(9)
  })
})

describe('formatLocationAnnotation', () => {
  it('emits lat/lng for a bare pin (no venue)', () => {
    const s = formatLocationAnnotation({ lat: 30.275796, lng: 120.127970, createdAt: 0 })
    expect(s).toBe('[user just shared location: lat=30.275796, lng=120.127970]')
  })

  it('includes accuracy when present, rounded to integer', () => {
    const s = formatLocationAnnotation({ lat: 1, lng: 2, accuracy: 4.7, createdAt: 0 })
    expect(s).toBe('[user just shared location: lat=1.000000, lng=2.000000, accuracy_m=5]')
  })

  it('JSON-quotes venue name + address so commas/quotes inside are safe', () => {
    const s = formatLocationAnnotation({
      lat: 30, lng: 120,
      venueLabel: '竹哩·栅 (万科中心店)',
      venueAddress: '学院路77号, 黄龙国际中心',
      createdAt: 0,
    })
    expect(s).toContain('name="竹哩·栅 (万科中心店)"')
    expect(s).toContain('address="学院路77号, 黄龙国际中心"')
  })

  it('skips accuracy when not a finite number', () => {
    const s = formatLocationAnnotation({ lat: 1, lng: 2, accuracy: NaN, createdAt: 0 })
    expect(s).not.toContain('accuracy_m')
  })
})
