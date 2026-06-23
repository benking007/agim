import { describe, it, expect, afterEach } from 'bun:test'
import { nextRevealLen, resolveTickMs, streamSmoothingEnabled } from './stream-reveal.js'

describe('nextRevealLen', () => {
  it('returns current when already caught up (never moves backward)', () => {
    expect(nextRevealLen(10, 10)).toBe(10)
    expect(nextRevealLen(12, 8)).toBe(12) // target < current → stay
  })

  it('never overshoots the target', () => {
    expect(nextRevealLen(9, 10)).toBe(10)
    expect(nextRevealLen(0, 1)).toBe(1)
  })

  it('advances by at least minStep on small gaps', () => {
    expect(nextRevealLen(0, 100, { minStep: 2, div: 6 })).toBe(17) // ceil(100/6)=17
    expect(nextRevealLen(98, 100, { minStep: 2, div: 6 })).toBe(100) // floor caps at target
  })

  it('big gap advances by the proportional step', () => {
    // ceil(600/6) = 100
    expect(nextRevealLen(0, 600, { minStep: 2, div: 6 })).toBe(100)
  })

  it('monotonically converges to target', () => {
    let cur = 0
    const target = 1234
    let iters = 0
    while (cur < target) {
      const next = nextRevealLen(cur, target)
      expect(next).toBeGreaterThan(cur)
      expect(next).toBeLessThanOrEqual(target)
      cur = next
      if (++iters > 10000) throw new Error('did not converge')
    }
    expect(cur).toBe(target)
  })
})

describe('resolveTickMs / streamSmoothingEnabled', () => {
  afterEach(() => {
    delete process.env.IMHUB_TUI_STREAM_FPS
    delete process.env.IMHUB_TUI_STREAM_SMOOTH
  })

  it('defaults to 40ms (~25fps)', () => {
    expect(resolveTickMs()).toBe(40)
  })

  it('honours IMHUB_TUI_STREAM_FPS', () => {
    process.env.IMHUB_TUI_STREAM_FPS = '50'
    expect(resolveTickMs()).toBe(20)
  })

  it('clamps absurd fps to a sane floor', () => {
    process.env.IMHUB_TUI_STREAM_FPS = '100000'
    expect(resolveTickMs()).toBe(10)
  })

  it('smoothing on by default, off when env=0', () => {
    expect(streamSmoothingEnabled()).toBe(true)
    process.env.IMHUB_TUI_STREAM_SMOOTH = '0'
    expect(streamSmoothingEnabled()).toBe(false)
  })
})
