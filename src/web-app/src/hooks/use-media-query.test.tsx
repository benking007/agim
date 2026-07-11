/**
 * useMediaQuery / useIsDesktop — locks the SSR-safe initialiser and
 * the change-event subscription behaviour. Tests run in jsdom which
 * supplies a synthesised matchMedia (in setup.ts); we mock per-test
 * to drive specific media-query matches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIsDesktop, useMediaQuery } from './use-media-query'

interface MockMediaQueryList {
  matches: boolean
  media: string
  addEventListener: (type: 'change', cb: (e: MediaQueryListEvent) => void) => void
  removeEventListener: (type: 'change', cb: (e: MediaQueryListEvent) => void) => void
  fire: (matches: boolean) => void
}

function installMatchMedia(initial: boolean): MockMediaQueryList {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql: MockMediaQueryList = {
    matches: initial,
    media: '(min-width: 640px)',
    addEventListener: (_t, cb) => { listeners.add(cb) },
    removeEventListener: (_t, cb) => { listeners.delete(cb) },
    fire: (matches) => {
      mql.matches = matches
      const e = { matches, media: mql.media } as MediaQueryListEvent
      listeners.forEach((cb) => { cb(e) })
    },
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ ...mql, media: q }),
  })
  // Replace methods so addEventListener mutates the SAME listeners set
  // (the spread above broke the reference).
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string): MockMediaQueryList => Object.assign(Object.create(null), mql, { media: q }),
  })
  return mql
}

describe('useMediaQuery', () => {
  const origMatchMedia = window.matchMedia
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => {
    if (origMatchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: origMatchMedia,
      })
    }
  })

  it('returns the initial match from matchMedia synchronously (initialiser path)', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'))
    expect(result.current).toBe(true)
  })

  it('returns false when matchMedia is missing (test env / SSR)', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'))
    expect(result.current).toBe(false)
  })

  it('useIsDesktop is a thin wrapper around `(min-width: 640px)`', () => {
    installMatchMedia(false)
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)
  })

  it('unsubscribes on unmount (no listener leak across remounts)', () => {
    // We don't need a real fire path here — just verify removeEventListener
    // is called on unmount. Use a spy installed onto the mql.
    const remove = vi.fn()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: false,
        media: q,
        addEventListener: () => {},
        removeEventListener: remove,
      }),
    })
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 640px)'))
    unmount()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('updates when matchMedia fires a change event', () => {
    let listener: ((e: MediaQueryListEvent) => void) | null = null
    const mql = {
      matches: false,
      media: '(min-width: 640px)',
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => { listener = cb },
      removeEventListener: () => {},
    }
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => mql,
    })
    const { result } = renderHook(() => useMediaQuery('(min-width: 640px)'))
    expect(result.current).toBe(false)
    act(() => {
      mql.matches = true
      listener?.({ matches: true, media: mql.media } as MediaQueryListEvent)
    })
    expect(result.current).toBe(true)
  })
})
