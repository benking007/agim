import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearComposerIslands,
  getComposerIsland,
  patchComposerIsland,
} from './portal-composer-islands'

const A = 'web-aaaa1111'
const B = 'web-bbbb2222'

describe('portal composer islands', () => {
  beforeEach(() => {
    clearComposerIslands()
  })

  it('keeps drafts isolated per thread', () => {
    patchComposerIsland(A, { input: '给 A 的草稿' })
    patchComposerIsland(B, { input: '给 B 的草稿' })
    expect(getComposerIsland(A).input).toBe('给 A 的草稿')
    expect(getComposerIsland(B).input).toBe('给 B 的草稿')
  })

  it('keeps queued steers isolated per thread', () => {
    patchComposerIsland(A, { pendingSends: [{ id: 'q1', text: 'steer A' }] })
    expect(getComposerIsland(B).pendingSends).toEqual([])
    expect(getComposerIsland(A).pendingSends).toEqual([{ id: 'q1', text: 'steer A' }])
  })

  it('does not leak attachments across threads', () => {
    patchComposerIsland(A, {
      attachments: [{
        id: '1',
        name: 'a.png',
        mime: 'image/png',
        kind: 'image',
        file: new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      }],
    })
    expect(getComposerIsland(B).attachments).toEqual([])
    expect(getComposerIsland(A).attachments).toHaveLength(1)
  })
})
