/**
 * Track the iOS/Android soft-keyboard inset via visualViewport.
 *
 * Sticky footers with only `dvh` / safe-area often sit *under* the
 * keyboard on iOS Safari. The visual viewport shrinks when the
 * keyboard opens; the delta from `window.innerHeight` is the amount
 * we should lift the composer (or pad the page).
 *
 * Returns pixels of keyboard overlap at the bottom of the layout
 * viewport (0 when keyboard is closed).
 */

import { useEffect, useState } from 'react'

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = (): void => {
      // Layout height minus (visual top offset + visual height) ≈
      // obscured bottom region (keyboard + browser chrome animation).
      const obscured = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      // Ignore tiny jitter from URL-bar show/hide (< 24px).
      setInset(obscured > 24 ? Math.round(obscured) : 0)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return inset
}
