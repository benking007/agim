import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  CHAT_MEDIA_COMPRESS_MIN_BYTES,
  formatChatMediaUploadError,
  prepareFileForUpload,
} from './chat-media-upload'

describe('formatChatMediaUploadError', () => {
  it('explains Cloudflare/gateway 524 instead of "upload 524"', () => {
    const zh = formatChatMediaUploadError(524, '', true)
    expect(zh).toMatch(/上传超时/)
    expect(zh).not.toBe('upload 524')

    const en = formatChatMediaUploadError(524, '', false)
    expect(en).toMatch(/timed out/i)
    expect(en).not.toBe('upload 524')
  })

  it('maps 502/504 the same way', () => {
    expect(formatChatMediaUploadError(502, '<html>Error</html>', true)).toMatch(/上传超时/)
    expect(formatChatMediaUploadError(504, '', false)).toMatch(/timed out/i)
  })

  it('parses MEDIA_TOO_LARGE JSON bodies', () => {
    const msg = formatChatMediaUploadError(
      413,
      JSON.stringify({ error: 'file too large', code: 'MEDIA_TOO_LARGE' }),
      true,
    )
    expect(msg).toMatch(/过大/)
  })

  it('prefers JSON error field over HTML', () => {
    const msg = formatChatMediaUploadError(
      500,
      JSON.stringify({ error: 'disk full', code: 'MEDIA_UPLOAD_FAILED' }),
      false,
    )
    expect(msg).toBe('disk full')
  })
})

describe('prepareFileForUpload', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {},
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('leaves non-images and small images unchanged', async () => {
    const txt = new File([new Uint8Array(100)], 'a.txt', { type: 'text/plain' })
    expect(await prepareFileForUpload(txt)).toBe(txt)

    const small = new File(
      [new Uint8Array(1000)],
      's.png',
      { type: 'image/png' },
    )
    expect(await prepareFileForUpload(small)).toBe(small)

    const gif = new File(
      [new Uint8Array(CHAT_MEDIA_COMPRESS_MIN_BYTES + 10)],
      'a.gif',
      { type: 'image/gif' },
    )
    expect(await prepareFileForUpload(gif)).toBe(gif)
  })

  it('recompresses large still images via canvas', async () => {
    class FakeImage {
      naturalWidth = 4000
      naturalHeight = 3000
      width = 4000
      height = 3000
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', FakeImage)

    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: vi.fn(),
      }),
      toBlob: (cb: (b: Blob | null) => void) => {
        cb(new Blob([new Uint8Array(80_000)], { type: 'image/jpeg' }))
      },
    }
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return canvas as unknown as HTMLCanvasElement
      return document.createElement(tag)
    })

    const big = new File(
      [new Uint8Array(CHAT_MEDIA_COMPRESS_MIN_BYTES + 50_000)],
      'photo.heic.png',
      { type: 'image/png' },
    )
    const out = await prepareFileForUpload(big)
    expect(out).not.toBe(big)
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toMatch(/\.jpg$/)
    expect(out.size).toBeLessThan(big.size)
  })
})
