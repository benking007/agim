import { describe, expect, it } from 'vitest'
import {
  prefersComposerEnterNewline,
  shouldSubmitOnEnterKey,
} from './composer-enter'

describe('prefersComposerEnterNewline', () => {
  it('is true for Agim iOS shell', () => {
    expect(prefersComposerEnterNewline({ platform: 'ios' })).toBe(true)
  })

  it('is false for Agim macOS shell (Enter sends)', () => {
    expect(prefersComposerEnterNewline({ platform: 'macos' })).toBe(false)
  })

  it('is false for desktop browser', () => {
    expect(prefersComposerEnterNewline({ platform: 'browser', mobileBrowser: false })).toBe(false)
  })

  it('is true for mobile browser (not Agim shell)', () => {
    expect(prefersComposerEnterNewline({ platform: 'browser', mobileBrowser: true })).toBe(true)
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
