import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAgimNativeShell } from './agim-shell'

describe('isAgimNativeShell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    // Restore any direct window.webkit mutation.
    delete (window as { webkit?: unknown }).webkit
  })

  it('is false in a plain browser (no Agim handlers)', () => {
    expect(isAgimNativeShell()).toBe(false)
  })

  it('is true when agimShare is registered', () => {
    ;(window as Window).webkit = {
      messageHandlers: {
        agimShare: { postMessage: () => {} },
      },
    }
    expect(isAgimNativeShell()).toBe(true)
  })

  it('is true when only agimSaveFile is registered', () => {
    ;(window as Window).webkit = {
      messageHandlers: {
        agimSaveFile: { postMessage: () => {} },
      },
    }
    expect(isAgimNativeShell()).toBe(true)
  })
})
