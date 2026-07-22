/**
 * Detect Agim native shells (iOS / macOS WKWebView) vs plain browser.
 *
 * Precision path: shells inject `window.__AGIM_SHELL__ = 'ios' | 'macos'`
 * at document-start (see apps/ios|macos WebShellView.swift).
 *
 * Fallback: presence of `webkit.messageHandlers.agimShare|agimSaveFile`
 * (both shells register these) plus UA heuristics to tell iOS from macOS.
 */

export type AgimShellPlatform = 'ios' | 'macos' | 'browser'

declare global {
  interface Window {
    /** Injected by Agim iOS / macOS WKWebView shells. */
    __AGIM_SHELL__?: AgimShellPlatform | string
  }
}

export function isAgimNativeShell(): boolean {
  if (typeof window === 'undefined') return false
  const marker = window.__AGIM_SHELL__
  if (marker === 'ios' || marker === 'macos') return true
  const handlers = window.webkit?.messageHandlers
  return Boolean(handlers?.agimShare || handlers?.agimSaveFile)
}

/**
 * Exact client surface for UX that differs by shell (Enter key, share, …).
 * - `ios` — Agim iPhone/iPad app WKWebView
 * - `macos` — Agim Mac app WKWebView
 * - `browser` — Safari / Chrome / Firefox / etc. (not an Agim shell)
 */
export function getAgimShellPlatform(): AgimShellPlatform {
  if (typeof window === 'undefined') return 'browser'

  const marker = window.__AGIM_SHELL__
  if (marker === 'ios' || marker === 'macos') return marker

  if (!isAgimNativeShell()) return 'browser'

  // Legacy shells (pre-marker): same bridges on both apps — use UA.
  return inferNativeShellFromUa(
    typeof navigator !== 'undefined' ? navigator.userAgent : '',
    typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  )
}

/** Exported for unit tests — UA fallback when `__AGIM_SHELL__` is absent. */
export function inferNativeShellFromUa(ua: string, maxTouchPoints = 0): 'ios' | 'macos' {
  if (/iPhone|iPod|iPad/i.test(ua)) return 'ios'
  // iPadOS 13+ WKWebView often reports Macintosh + touch.
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios'
  return 'macos'
}

/** Mobile browser (not Agim shell) — soft keyboard, Enter should newline. */
export function isMobileBrowserUa(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /Android|webOS|iPhone|iPod|iPad|BlackBerry|IEMobile|Opera Mini/i.test(ua)
    || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
}
