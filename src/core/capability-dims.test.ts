import { describe, expect, it } from 'bun:test'
import {
  CAPABILITY_DIMS,
  formatCapabilitiesCompact,
  normalizeCapabilityMap,
  normalizeCapabilityNotes,
} from './capability-dims.js'

describe('capability-dims', () => {
  it('normalizes partial maps onto fallback', () => {
    const caps = normalizeCapabilityMap({ coding: 'strong', finance: 'nope' as never })
    expect(caps.coding).toBe('strong')
    expect(caps.finance).toBe('medium')
    expect(CAPABILITY_DIMS).toHaveLength(5)
  })

  it('formats compact caps with notes', () => {
    const s = formatCapabilitiesCompact(
      {
        coding: 'strong',
        finance: 'medium',
        zhWriting: 'medium',
        reasoning: 'strong',
        dataCheck: 'strong',
      },
      { finance: '非专长', zhWriting: '翻译腔明显' },
    )
    expect(s).toContain('coding=strong')
    expect(s).toContain('finance=medium(非专长)')
    expect(s).toContain('zhWriting=medium(翻译腔明显)')
  })

  it('trims capability notes', () => {
    const notes = normalizeCapabilityNotes({
      finance: '  中文金融语料丰富  ',
      coding: '',
    })
    expect(notes.finance).toBe('中文金融语料丰富')
    expect(notes.coding).toBeUndefined()
  })
})
