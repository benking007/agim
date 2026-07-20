import { describe, expect, it } from 'vitest'
import { SHARE_TEXT_MAX, truncateForShare } from './share-content'

describe('truncateForShare', () => {
  it('returns short text unchanged', () => {
    expect(truncateForShare('hello')).toBe('hello')
  })

  it('truncates long text with an ellipsis', () => {
    const long = 'a'.repeat(SHARE_TEXT_MAX + 50)
    const out = truncateForShare(long)
    expect(out.length).toBe(SHARE_TEXT_MAX)
    expect(out.endsWith('…')).toBe(true)
  })

  it('trims trailing whitespace before measuring', () => {
    expect(truncateForShare('hi  \n')).toBe('hi')
  })
})
