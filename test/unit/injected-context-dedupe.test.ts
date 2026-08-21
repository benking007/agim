import { describe, expect, it } from 'bun:test'
import {
  INJECTED_CONTEXT_UNCHANGED_MARKER,
  dedupeInjectedContextForPersist,
  expandInjectedContextsInMessages,
  findLastFullInjectedContext,
  isInjectedContextUnchangedMarker,
  resolveInjectedContextText,
} from '../../src/core/injected-context-dedupe.js'

describe('injected-context-dedupe', () => {
  it('persists full text the first time and a marker when unchanged', () => {
    const full = '## System prompt\nskills…'
    expect(dedupeInjectedContextForPersist(full, undefined)).toBe(full)
    expect(dedupeInjectedContextForPersist(full, full)).toBe(INJECTED_CONTEXT_UNCHANGED_MARKER)
    expect(dedupeInjectedContextForPersist(`${full}\nextra`, full)).toBe(`${full}\nextra`)
  })

  it('expands markers against the prior full copy', () => {
    const full = '## System prompt\nhello'
    const messages = [
      { id: '1', activity: { injectedContext: full } },
      { id: '2', activity: { injectedContext: INJECTED_CONTEXT_UNCHANGED_MARKER } },
      { id: '3', activity: { injectedContext: INJECTED_CONTEXT_UNCHANGED_MARKER } },
    ]
    const expanded = expandInjectedContextsInMessages(messages)
    expect(expanded[1]?.activity?.injectedContext).toBe(full)
    expect(expanded[2]?.activity?.injectedContext).toBe(full)
    expect(findLastFullInjectedContext(messages)).toBe(full)
  })

  it('resolveInjectedContextText returns prior on marker', () => {
    expect(isInjectedContextUnchangedMarker(INJECTED_CONTEXT_UNCHANGED_MARKER)).toBe(true)
    expect(resolveInjectedContextText(INJECTED_CONTEXT_UNCHANGED_MARKER, 'prior')).toBe('prior')
    expect(resolveInjectedContextText('fresh', 'prior')).toBe('fresh')
  })
})
