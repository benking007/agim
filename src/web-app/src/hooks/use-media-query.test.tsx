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
      listeners.forEach((cb) => {
        cb(e)
      })
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
