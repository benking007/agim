import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatMediaMarker,
  guessMediaContentType,
  isUnsafeInlineMedia,
  mediaContentDisposition,
  resolveSafeWebMediaPath,
  saveWebChatMedia,
} from './web-media-upload.js'

describe('web-media-upload', () => {
  it('saves image under media/web and formats marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agim-web-media-'))
    process.env.AGIM_MEDIA_ROOT = root
    try {
      const saved = await saveWebChatMedia({
        threadId: 'web-abc',
        filename: 'shot.png',
        mime: 'image/png',
        body: Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]),
      })
      expect(saved.kind).toBe('image')
      expect(saved.path.startsWith(join(root, 'web', 'web-abc'))).toBe(true)
      expect(formatMediaMarker(saved)).toContain('[图片附件：')
      expect(formatMediaMarker(saved)).toContain(saved.path)
    } finally {
      delete process.env.AGIM_MEDIA_ROOT
      await rm(root, { recursive: true, force: true })
    }
  })

  it('formats non-image as file marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agim-web-media-'))
    process.env.AGIM_MEDIA_ROOT = root
    try {
      const saved = await saveWebChatMedia({
        threadId: 'web-abc',
        filename: 'notes.txt',
        mime: 'text/plain',
        body: Buffer.from('hello'),
      })
      expect(saved.kind).toBe('file')
      expect(formatMediaMarker(saved)).toMatch(/^\[文件附件：/)
    } finally {
      delete process.env.AGIM_MEDIA_ROOT
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolveSafeWebMediaPath rejects traversal outside media root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agim-web-media-'))
    process.env.AGIM_MEDIA_ROOT = root
    try {
      const dir = join(root, 'web', 't')
      await mkdir(dir, { recursive: true })
      const inside = join(dir, 'a.png')
      await writeFile(inside, 'x')
      expect(resolveSafeWebMediaPath(inside)).toBe(inside)
      expect(resolveSafeWebMediaPath(join(root, '..', 'secret'))).toBe(null)
      expect(resolveSafeWebMediaPath('/etc/passwd')).toBe(null)
    } finally {
      delete process.env.AGIM_MEDIA_ROOT
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not guess executable types for html/svg/xml (stored XSS)', () => {
    expect(guessMediaContentType('note.html')).toBe('application/octet-stream')
    expect(guessMediaContentType('img.svg')).toBe('application/octet-stream')
    expect(guessMediaContentType('data.xml')).toBe('application/octet-stream')
    expect(guessMediaContentType('shot.png')).toBe('image/png')
    expect(isUnsafeInlineMedia('x.html')).toBe(true)
    expect(isUnsafeInlineMedia('x.svg')).toBe(true)
    expect(mediaContentDisposition('x.html')).toMatch(/^attachment;/)
    expect(mediaContentDisposition('shot.png')).toMatch(/^inline;/)
  })
})
