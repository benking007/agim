// render-router — small surface, targeted tests focused on the
// envelope parse and the stray-tag stripping defence that was added
// after a real IM bubble leaked a literal `</im-summary>`.

import { describe, it, expect } from 'bun:test'
import { decideRender } from './render-router.js'

describe('decideRender — envelope parsing', () => {
  it('extracts summary + fullMd from a clean envelope', () => {
    const text = '<im-summary>one-liner</im-summary>\n<full-md>full body here</full-md>'
    const r = decideRender(text, { viewerEnabled: true })
    expect(r.mode).toBe('summary-link')
    if (r.mode === 'summary-link') {
      expect(r.summary).toBe('one-liner')
      expect(r.fullMd).toBe('full body here')
    }
  })

  it('strips nested `<im-summary>` block from captured summary (R-bug 2026-05)', () => {
    // The LLM emitted two `<im-summary>` blocks back-to-back; the
    // non-greedy regex absorbed a `</im-summary>` into the captured
    // summary, which then bled into the IM bubble as a visible tag.
    const text =
      '<im-summary>FIRST SUMMARY</im-summary>\n' +
      '<im-summary>SECOND SUMMARY</im-summary>\n' +
      '<full-md>BODY</full-md>'
    const r = decideRender(text, { viewerEnabled: true })
    expect(r.mode).toBe('summary-link')
    if (r.mode === 'summary-link') {
      // Neither closing nor opening envelope tags must survive in the
      // user-visible summary text.
      expect(r.summary).not.toContain('<im-summary>')
      expect(r.summary).not.toContain('</im-summary>')
      expect(r.summary).not.toContain('<full-md>')
    }
  })

  it('falls back to inline full body when envelope present but viewer disabled', () => {
    const text = '<im-summary>S</im-summary>\n<full-md>BODY</full-md>'
    const r = decideRender(text, { viewerEnabled: false })
    expect(r.mode).toBe('inline')
    if (r.mode === 'inline') {
      expect(r.inlineText).toBe('BODY')
    }
  })

  it('strips stray envelope tags from inline path when LLM omitted half-envelope', () => {
    // Half-envelope: only opening / closing tag, regex above can't match.
    // Defensive cleanup must still scrub the leaking tags.
    const text = 'hello world </im-summary>'
    const r = decideRender(text, { viewerEnabled: false })
    expect(r.mode).toBe('inline')
    if (r.mode === 'inline') {
      expect(r.inlineText).not.toContain('</im-summary>')
      expect(r.inlineText).toContain('hello world')
    }
  })

  it('empty input returns inline empty', () => {
    expect(decideRender('', { viewerEnabled: true })).toEqual({ mode: 'inline', inlineText: '' })
    expect(decideRender('   \n\n  ', { viewerEnabled: true })).toEqual({ mode: 'inline', inlineText: '' })
  })
})
