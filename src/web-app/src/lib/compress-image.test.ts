import { describe, expect, it } from 'vitest'
import { shouldCompressImage } from './compress-image'

describe('shouldCompressImage', () => {
  it('skips small or non-image files', () => {
    expect(shouldCompressImage(new File(['x'], 'a.png', { type: 'image/png' }))).toBe(false)
    expect(shouldCompressImage(new File([new Uint8Array(500_000)], 'a.txt', { type: 'text/plain' }))).toBe(false)
    expect(shouldCompressImage(new File([new Uint8Array(500_000)], 'a.gif', { type: 'image/gif' }))).toBe(false)
  })

  it('compresses large raster photos', () => {
    expect(shouldCompressImage(new File([new Uint8Array(500_000)], 'cam.jpg', { type: 'image/jpeg' }))).toBe(true)
  })
})
