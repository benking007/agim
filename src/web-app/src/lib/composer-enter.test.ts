import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  prefersComposerEnterNewline,
  shouldSubmitOnEnterKey,
} from './composer-enter'

function stubMatchMedia(map: Record<string, boolean>): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: map[query] ?? false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

describe('prefersComposerEnterNewline', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is true on narrow viewports', () => {
    stubMatchMedia({ '(max-width: 1023px)': true, '(pointer: coarse)': false })
    expect(prefersComposerEnterNewline(window)).toBe(true)
  })

  it('is true on coarse pointers even when wide', () => {
    stubMatchMedia({ '(max-width: 1023px)': false, '(pointer: coarse)': true })
    expect(prefersComposerEnterNewline(window)).toBe(true)
  })

  it('is false on wide fine-pointer desktops', () => {
    stubMatchMedia({ '(max-width: 1023px)': false, '(pointer: coarse)': false })
    expect(prefersComposerEnterNewline(window)).toBe(false)
  })
})

describe('shouldSubmitOnEnterKey', () => {
  const bareEnter = {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  }

  it('submits on bare Enter in desktop mode', () => {
    expect(shouldSubmitOnEnterKey(bareEnter, { enterNewline: false })).toBe(true)
  })

  it('does not submit when enterNewline (phone) mode', () => {
    expect(shouldSubmitOnEnterKey(bareEnter, { enterNewline: true })).toBe(false)
  })

  it('does not submit on Ctrl/⌘/Shift+Enter (newline)', () => {
    expect(shouldSubmitOnEnterKey({ ...bareEnter, ctrlKey: true }, { enterNewline: false })).toBe(false)
    expect(shouldSubmitOnEnterKey({ ...bareEnter, metaKey: true }, { enterNewline: false })).toBe(false)
    expect(shouldSubmitOnEnterKey({ ...bareEnter, shiftKey: true }, { enterNewline: false })).toBe(false)
  })

  it('ignores IME composing', () => {
    expect(shouldSubmitOnEnterKey(bareEnter, { enterNewline: false, isComposing: true })).toBe(false)
  })
})
