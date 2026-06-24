import { describe, it, expect } from 'bun:test'
import { extractWheel } from './mouse-stdin.js'

describe('extractWheel', () => {
  it('returns plain keystrokes untouched (no mouse)', () => {
    const r = extractWheel('hello')
    expect(r.clean).toBe('hello')
    expect(r.deltas).toEqual([])
  })

  it('decodes wheel up (64) as -1 and strips the sequence', () => {
    const r = extractWheel('\x1b[<64;10;5M')
    expect(r.clean).toBe('')
    expect(r.deltas).toEqual([-1])
  })

  it('decodes wheel down (65) as +1', () => {
    const r = extractWheel('\x1b[<65;10;5M')
    expect(r.deltas).toEqual([1])
  })

  it('keeps surrounding keystrokes and CJK intact while stripping mouse', () => {
    const r = extractWheel('ab\x1b[<64;10;5M你好\x1b[<65;12;7Mcd')
    expect(r.clean).toBe('ab你好cd')
    expect(r.deltas).toEqual([-1, 1])
  })

  it('drops non-wheel mouse events (clicks/moves) without a delta', () => {
    // button 0 = left press, 35 = move — neither sets bit 64.
    const r = extractWheel('x\x1b[<0;3;4My\x1b[<35;3;4mz')
    expect(r.clean).toBe('xyz')
    expect(r.deltas).toEqual([])
  })

  it('handles wheel with modifier bits (e.g. ctrl+wheel 80/81)', () => {
    const r = extractWheel('\x1b[<80;1;1M\x1b[<81;1;1M')
    expect(r.deltas).toEqual([-1, 1])
    expect(r.clean).toBe('')
  })

  it('handles release form (lowercase m)', () => {
    const r = extractWheel('\x1b[<64;9;9m')
    expect(r.deltas).toEqual([-1])
    expect(r.clean).toBe('')
  })
})
