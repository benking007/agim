import { describe, expect, it } from 'vitest'
import { markdownFilenameFromContent } from './save-text-file'

describe('markdownFilenameFromContent', () => {
  it('slugs the first heading line and appends a stamp', () => {
    const name = markdownFilenameFromContent(
      '# Hello World\n\nbody',
      new Date('2026-07-20T08:03:00.000Z'),
    )
    expect(name).toBe('Hello-World-2026-07-20-08-03.md')
  })

  it('falls back when content is empty', () => {
    const name = markdownFilenameFromContent('   \n', new Date('2026-07-20T08:03:00.000Z'))
    expect(name).toBe('agim-reply-2026-07-20-08-03.md')
  })

  it('keeps CJK characters in the slug', () => {
    const name = markdownFilenameFromContent(
      '你好世界',
      new Date('2026-07-20T08:03:00.000Z'),
    )
    expect(name.startsWith('你好世界-')).toBe(true)
    expect(name.endsWith('.md')).toBe(true)
  })
})
