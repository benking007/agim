import { afterEach, describe, expect, it } from 'bun:test'
import {
  _resetTurnSteer,
  consumeTurnSteers,
  dispatchTurnSteer,
  enqueueTurnSteer,
  formatMidTurnSteer,
  hasLiveSteer,
  peekTurnSteers,
  registerLiveSteer,
  threadSteerKey,
} from './turn-steer.js'

afterEach(() => {
  _resetTurnSteer()
})

describe('turn-steer', () => {
  it('builds a stable thread key', () => {
    expect(threadSteerKey('web', 'web', 'web-1')).toBe('web:web:web-1')
  })

  it('wraps user text as a mid-turn supplement', () => {
    const out = formatMidTurnSteer('  also run tests  ')
    expect(out).toContain('【本轮补充】')
    expect(out).toContain('also run tests')
    expect(out.trim().endsWith('also run tests')).toBe(true)
  })

  it('queues when no live harness is registered', async () => {
    const mode = await dispatchTurnSteer('k', 'hello')
    expect(mode).toBe('queued')
    expect(peekTurnSteers('k').map((i) => i.text)).toEqual(['hello'])
  })

  it('dispatches to a live harness immediately', async () => {
    const seen: string[] = []
    const unreg = registerLiveSteer('k', async (text) => {
      seen.push(text)
    })
    expect(hasLiveSteer('k')).toBe(true)
    expect(await dispatchTurnSteer('k', 'now')).toBe('live')
    expect(seen).toEqual(['now'])
    expect(peekTurnSteers('k')).toEqual([])
    unreg()
    expect(hasLiveSteer('k')).toBe(false)
  })

  it('drains queued items when a harness registers', async () => {
    enqueueTurnSteer('k', 'first')
    enqueueTurnSteer('k', 'second')
    const seen: string[] = []
    const unreg = registerLiveSteer('k', async (text) => {
      seen.push(text)
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toEqual(['first', 'second'])
    expect(consumeTurnSteers('k')).toEqual([])
    unreg()
  })

  it('re-queues when the live fn throws', async () => {
    const unreg = registerLiveSteer('k', async () => {
      throw new Error('idle')
    })
    expect(await dispatchTurnSteer('k', 'x')).toBe('queued')
    expect(peekTurnSteers('k').map((i) => i.text)).toEqual(['x'])
    unreg()
  })
})
