import { describe, expect, it } from 'vitest'

import { shouldFlushHeldSends } from './flush-held-sends'

describe('shouldFlushHeldSends', () => {
  it('does not flush on first paint while idle', () => {
    expect(shouldFlushHeldSends({ wasBusy: false, isBusy: false })).toBe(false)
  })

  it('does not flush while history is still loading', () => {
    expect(shouldFlushHeldSends({
      wasBusy: true, isBusy: false, historyLoading: true,
    })).toBe(false)
  })

  it('does not flush when becoming busy', () => {
    expect(shouldFlushHeldSends({ wasBusy: false, isBusy: true })).toBe(false)
  })

  it('flushes only on a busy → idle edge', () => {
    expect(shouldFlushHeldSends({ wasBusy: true, isBusy: false })).toBe(true)
    expect(shouldFlushHeldSends({ wasBusy: true, isBusy: true })).toBe(false)
  })
})
