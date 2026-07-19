import { describe, expect, it } from 'vitest'
import { parseUserMediaContent } from './parse-user-media'

describe('parseUserMediaContent', () => {
  it('keeps plain text intact', () => {
    expect(parseUserMediaContent('hello\nworld')).toEqual([
      { kind: 'text', text: 'hello\nworld' },
    ])
  })

  it('parses image and file markers with trailing text', () => {
    const raw = [
      '[图片附件：/tmp/media/web/t/a.png]',
      '[文件附件：/tmp/media/web/t/b.txt (notes.txt, 12 B)]',
      'see the photo',
    ].join('\n')
    const segs = parseUserMediaContent(raw)
    expect(segs[0]).toEqual({ kind: 'image', path: '/tmp/media/web/t/a.png' })
    expect(segs[1]).toEqual({
      kind: 'file',
      path: '/tmp/media/web/t/b.txt',
      name: 'notes.txt',
      size: '12 B',
    })
    expect(segs.some((s) => s.kind === 'text' && s.text.includes('see the photo'))).toBe(true)
  })

  it('supports long unbroken text segments', () => {
    const long = `324244243432324324325r${'234'.repeat(40)}`
    expect(parseUserMediaContent(long)[0]).toEqual({ kind: 'text', text: long })
  })
})
