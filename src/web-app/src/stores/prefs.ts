/**
 * stores/prefs.ts — global user preferences. Single zustand store
 * (persisted to localStorage) covering theme + language for now;
 * future PRs may add sidebar collapsed, lastActiveWorkspace, etc.
 *
 * Persistence key strategy:
 *   theme    — `agim-theme` ('system' is stored as absence, matching
 *              the legacy _app.js behavior, so v1 → v2 carry-over
 *              is byte-for-byte compatible).
 *   lang     — `im-hub-lang`, the existing key every legacy HTML
 *              reads. Mirrors the lang the user picked in v1 so
 *              upgrading doesn't reset the UI to English.
 *
 * The store uses the canonical zustand persist middleware with a
 * custom serializer (rather than the auto-JSON wrapper) so each
 * piece sits at its own localStorage key — that's what makes the
 * v1/v2 sharing work.
 */

import { create } from 'zustand'
import { useEffect } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
export type Lang = 'en' | 'zh'

const THEME_KEY = 'agim-theme'
const LANG_KEY = 'im-hub-lang'

interface PrefsState {
  theme: ThemeMode
  lang: Lang
  setTheme: (mode: ThemeMode) => void
  cycleTheme: () => void
  setLang: (lang: Lang) => void
}

function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* private-mode */
  }
  return 'system'
}

function readLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY)
    if (v === 'en' || v === 'zh') return v
  } catch {
    /* private-mode */
  }
  // No persisted value yet — match the browser preference once, then
  // freeze on first explicit user choice.
  const nav = (navigator.language || 'en').toLowerCase()
  return nav.startsWith('zh') ? 'zh' : 'en'
}

function writeTheme(mode: ThemeMode): void {
  try {
    if (mode === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, mode)
  } catch {
    /* ignore */
  }
}

function writeLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    /* ignore */
  }
}

export const usePrefs = create<PrefsState>((set, get) => ({
  theme: readTheme(),
  lang: readLang(),
  setTheme: (mode) => {
    writeTheme(mode)
    set({ theme: mode })
  },
  cycleTheme: () => {
    const cur = get().theme
    const next: ThemeMode = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system'
    writeTheme(next)
    set({ theme: next })
  },
  setLang: (lang) => {
    writeLang(lang)
    set({ lang })
  },
}))

/**
 * applyThemeToDocument — keeps `<html data-theme>` in sync with the
 * active theme. Mirrors the IIFE in index.html so the first paint and
 * subsequent toggles look identical.
 */
function applyThemeToDocument(mode: ThemeMode): void {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', mode)
}

/**
 * useApplyTheme — call from <App>. Subscribes to theme + the
 * `prefers-color-scheme` media query so `system` mode tracks OS
 * preference changes without a reload. The IIFE in index.html
 * applied the initial value before React hydrated; this hook
 * keeps it consistent thereafter.
 */
export function useApplyTheme(): void {
  const theme = usePrefs((s) => s.theme)
  useEffect(() => {
    applyThemeToDocument(theme)
    if (theme !== 'system') return
    // Watch OS preference flips. The CSS itself handles the colors via
    // a prefers-color-scheme @media block; we only need to nudge a
    // re-render when sonner's portaled toast or any other root-themed
    // surface needs to observe the change.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyThemeToDocument(theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
}

/** Test-only — reset to initial defaults without touching localStorage. */
export function _resetPrefsForTest(): void {
  usePrefs.setState({ theme: 'system', lang: 'en' })
}
