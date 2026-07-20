import { describe, expect, it } from 'vitest'
import { sanitizeDisplayText } from './sanitize-display-text'

describe('sanitizeDisplayText', () => {
  it('rewrites middot / arrows / ellipsis to ASCII', () => {
    expect(sanitizeDisplayText('claude-code · 4s → #1920…')).toBe('claude-code | 4s -> #1920...')
  })

  it('strips emoji used in approval / status toasts', () => {
    const raw = '⏱ 自动放行 · bash · ls\n✅ 已批准'
    const out = sanitizeDisplayText(raw)
    expect(out).not.toMatch(/⏱|✅/)
    expect(out).toContain('自动放行 | bash | ls')
    expect(out).toContain('已批准')
  })

  it('keeps authentication_failed and latin identifiers intact', () => {
    expect(sanitizeDisplayText('authentication_failed')).toBe('authentication_failed')
    expect(sanitizeDisplayText('#1920')).toBe('#1920')
  })
})
