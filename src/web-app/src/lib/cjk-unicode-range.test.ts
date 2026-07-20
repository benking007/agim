import { describe, expect, it } from 'vitest'
import { AGIM_CJK_UNICODE_RANGE } from './cjk-unicode-range'

describe('AGIM_CJK_UNICODE_RANGE', () => {
  it('covers CJK unified ideographs', () => {
    expect(AGIM_CJK_UNICODE_RANGE).toContain('U+4E00-9FFF')
  })

  it('does not claim emoji / dingbat blocks used in slash replies', () => {
    // 📋 U+1F4CB, ⭐ U+2B50, ✅ U+2705, ⚠️ U+26A0, 🧠 U+1F9E0
    expect(AGIM_CJK_UNICODE_RANGE).not.toMatch(/U\+1F[0-9A-F]/i)
    expect(AGIM_CJK_UNICODE_RANGE).not.toContain('U+2B50')
    expect(AGIM_CJK_UNICODE_RANGE).not.toContain('U+2600-26FF')
    expect(AGIM_CJK_UNICODE_RANGE).not.toContain('U+2700-27BF')
  })

  it('does not claim Latin middot / arrows used in run status chips', () => {
    // · U+00B7, → U+2192 — must fall through to system faces
    expect(AGIM_CJK_UNICODE_RANGE).not.toMatch(/U\+00B[0-9A-F]/i)
    expect(AGIM_CJK_UNICODE_RANGE).not.toMatch(/U\+219[0-9A-F]/i)
  })
})
