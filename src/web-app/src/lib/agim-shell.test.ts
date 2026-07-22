import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAgimShellPlatform,
  inferNativeShellFromUa,
  isAgimNativeShell,
  isMobileBrowserUa,
} from './agim-shell'

describe('isAgimNativeShell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as { webkit?: unknown }).webkit
    delete window.__AGIM_SHELL__
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

  it('is true when __AGIM_SHELL__ marker is set', () => {
    window.__AGIM_SHELL__ = 'ios'
    expect(isAgimNativeShell()).toBe(true)
  })
})

describe('getAgimShellPlatform', () => {
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit
    delete window.__AGIM_SHELL__
  })

  it('reads explicit ios / macos markers', () => {
    window.__AGIM_SHELL__ = 'ios'
    expect(getAgimShellPlatform()).toBe('ios')
    window.__AGIM_SHELL__ = 'macos'
    expect(getAgimShellPlatform()).toBe('macos')
  })

  it('is browser without shell bridges', () => {
    expect(getAgimShellPlatform()).toBe('browser')
  })

  it('falls back to UA when bridges exist without marker', () => {
    ;(window as Window).webkit = {
      messageHandlers: { agimShare: { postMessage: () => {} } },
    }
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    })
    expect(getAgimShellPlatform()).toBe('ios')
  })
})

describe('inferNativeShellFromUa', () => {
  it('classifies iPhone / iPad and iPadOS Macintosh+touch', () => {
    expect(inferNativeShellFromUa('… iPhone …')).toBe('ios')
    expect(inferNativeShellFromUa('… iPad …')).toBe('ios')
    expect(inferNativeShellFromUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios')
    expect(inferNativeShellFromUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('macos')
  })
})

describe('isMobileBrowserUa', () => {
  it('detects phone / Android UAs', () => {
    expect(isMobileBrowserUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isMobileBrowserUa('Mozilla/5.0 (Linux; Android 14) Chrome/120')).toBe(true)
    expect(isMobileBrowserUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120')).toBe(false)
  })
})
