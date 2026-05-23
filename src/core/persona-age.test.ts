// Pure-renderer tests for the persona snippet's P0 #4 row-age tag.
// Exercises renderPersonaSnippet directly so we don't need the
// SQLite-backed memory store at test time.

import { describe, it, expect } from 'bun:test'
import { renderPersonaSnippet } from './persona.js'

describe('renderPersonaSnippet — row-age annotation (P0 #4)', () => {
  it('returns empty when no profile and zero facts', () => {
    expect(renderPersonaSnippet(null, 0)).toBe('')
  })

  it('appends "summary last consolidated …" tag when profile.updated_at is set', () => {
    const threeDaysAgoSec = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60
    const out = renderPersonaSnippet(
      { user_key: 'k', summary: 'likes coffee', updated_at: threeDaysAgoSec },
      5,
    )
    expect(out).toContain('summary last consolidated')
    expect(out).toContain('d ago')
    expect(out).toContain('likes coffee')
    expect(out).toContain('[long-term memory]')
    expect(out).toContain('[/long-term memory]')
  })

  it('uses minute granularity for very recent consolidation', () => {
    const fiveMinAgoSec = Math.floor(Date.now() / 1000) - 5 * 60
    const out = renderPersonaSnippet(
      { user_key: 'k', summary: 'x', updated_at: fiveMinAgoSec },
      1,
    )
    expect(out).toContain('5min ago')
  })

  it('omits the age tag when persona has no updated_at', () => {
    const out = renderPersonaSnippet(
      { user_key: 'k', summary: 'something', updated_at: 0 },
      1,
    )
    expect(out).toContain('something')
    expect(out).not.toContain('summary last consolidated')
  })

  it('renders the no-summary-yet path when only facts exist', () => {
    const out = renderPersonaSnippet(null, 3)
    expect(out).toContain('3 stored fact(s)')
    expect(out).not.toContain('summary last consolidated')
  })

  it('still includes the memory_query / memory_save guidance', () => {
    const out = renderPersonaSnippet(
      { user_key: 'k', summary: 'x', updated_at: Math.floor(Date.now() / 1000) },
      1,
    )
    expect(out).toContain('memory_query')
    expect(out).toContain('memory_save')
  })
})
