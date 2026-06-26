import { describe, it, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { extractWheel, createMouseStdin } from './mouse-stdin.js'

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

  it('ignores horizontal tilt buttons 66/67 (no vertical delta)', () => {
    const r = extractWheel('a\x1b[<66;3;4Mb\x1b[<67;3;4Mc')
    expect(r.deltas).toEqual([])
    expect(r.clean).toBe('abc')
  })
})

describe('createMouseStdin — SGR report split across reads', () => {
  function fakeReal(): PassThrough & { isTTY: boolean; setRawMode: () => unknown; ref: () => void; unref: () => void } {
    const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => unknown; ref: () => void; unref: () => void }
    s.isTTY = true
    s.setRawMode = () => s
    s.ref = () => {}
    s.unref = () => {}
    return s
  }

  it('buffers a wheel report split across two chunks (no fragment leaks)', async () => {
    const real = fakeReal()
    const m = createMouseStdin(real as unknown as NodeJS.ReadStream)
    const deltas: number[] = []
    m.wheel.on('wheel', (d: number) => deltas.push(d))
    let passed = ''
    m.stdin.setEncoding('utf8')
    m.stdin.on('data', (c: string) => { passed += c })

    real.write('ab\x1b[<64;10;')          // first half of the wheel report
    await new Promise((r) => setTimeout(r, 10))
    real.write('5Mcd')                     // second half completes it
    await new Promise((r) => setTimeout(r, 10))

    expect(deltas).toEqual([-1])           // one wheel-up, decoded once
    expect(passed).toBe('abcd')            // no \x1b[<.. fragment leaked
  })
})
