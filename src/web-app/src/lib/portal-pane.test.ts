import { describe, expect, it } from 'vitest'
import { parsePortalPane } from './portal-pane'

describe('parsePortalPane', () => {
  it('accepts the three tool panes and defaults to chat', () => {
    expect(parsePortalPane('skills')).toBe('skills')
    expect(parsePortalPane('automation')).toBe('automation')
    expect(parsePortalPane('library')).toBe('library')
    expect(parsePortalPane('chat')).toBe('chat')
    expect(parsePortalPane(null)).toBe('chat')
    expect(parsePortalPane('nope')).toBe('chat')
  })
})
