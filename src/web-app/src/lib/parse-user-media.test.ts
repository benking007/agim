import { describe, expect, it } from 'vitest'
import { groupUserContentBlocks, parseUserMediaContent } from './parse-user-media'

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

  it('parses workspace / skill mention markers', () => {
    const raw = '[工作区] 请看 [工作区文件：src/app.ts] 并用 [技能：create-skill]'
    const segs = parseUserMediaContent(raw)
    expect(segs).toEqual([
      { kind: 'workspace' },
      { kind: 'text', text: ' 请看 ' },
      { kind: 'ws-file', path: 'src/app.ts', isDir: false },
      { kind: 'text', text: ' 并用 ' },
      { kind: 'skill', name: 'create-skill' },
    ])
    const blocks = groupUserContentBlocks(segs)
    expect(blocks.some((b) => b.kind === 'mention')).toBe(true)
  })
})

describe('groupUserContentBlocks', () => {
  it('packs consecutive images into one grid block', () => {
    const segs = parseUserMediaContent([
      '[图片附件：/a/1.png]',
      '[图片附件：/a/2.png]',
      '[图片附件：/a/3.png]',
      '[文件附件：/a/n.txt (notes.txt, 1 B)]',
      'see the photo',
    ].join('\n'))
    const blocks = groupUserContentBlocks(segs)
    expect(blocks[0]).toEqual({ kind: 'images', paths: ['/a/1.png', '/a/2.png', '/a/3.png'] })
    expect(blocks[1]).toEqual({
      kind: 'files',
      files: [{ path: '/a/n.txt', name: 'notes.txt' }],
    })
    expect(blocks[2]).toEqual({ kind: 'text', text: 'see the photo' })
  })
})
