/**
 * useMediaQuery + useIsDesktop — viewport-driven render branches.
 *
 * The shell's Topbar pre-R10 rendered its nav twice (once for desktop
 * inline, once for mobile second-row strip), relying on Tailwind's
 * `hidden` / `sm:hidden` to hide one. jsdom doesn't strip
 * `display:none` elements from the accessibility tree, so
 * `getByRole('link', { name: 'Chat' })` matched both — three tests
 * failed every run. Real screen readers were also announcing every
 * nav item twice.
 *
 * This hook gives the same render the right shape at runtime: read
 * the breakpoint via `matchMedia`, render once, and only swap when
 * the viewport actually crosses the line.
 *
 * SPA-only: no SSR mismatch concern. On first render before the
 * `useEffect` populates, we read the matchMedia value synchronously
 * in the initializer so the first paint is already correct on a
 * desktop / mobile load (initialiser runs in both browser + jsdom).
 */

import { useEffect, useState } from 'react'

/** Subscribe to a media query string. Stable identity per query. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    // jsdom + the test environment provide a matchMedia mock that
    // always returns matches=false. SSR-time would fail; we don't SSR.
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches)
    // Match the current value once on mount in case the user resized
    // between SSR and hydration (paranoia for the future-SSR case).
    setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** `≥ sm` breakpoint (Tailwind default = 640px). Topbar uses this to
 *  pick between inline desktop nav and the row-2 mobile strip. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 640px)')
}
