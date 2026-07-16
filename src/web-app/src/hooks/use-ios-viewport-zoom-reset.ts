/**
 * Snap back if iOS Safari left the page zoomed after the soft keyboard closes.
 * Complements 16px chat inputs — recovers from any leftover auto-zoom.
 */

import { useEffect } from 'react'

import { resetIosViewportZoom } from '@/lib/ios-viewport-zoom'

export function useIosViewportZoomReset(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const maybeReset = (): void => {
      const obscured = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      // Keyboard closed (or nearly) but still zoomed → snap back.
      if (obscured <= 24 && vv.scale > 1.01) resetIosViewportZoom()
    }

    const onFocusOut = (e: FocusEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t) return
      const tag = t.tagName
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !t.isContentEditable) return
      window.setTimeout(maybeReset, 280)
    }

    vv.addEventListener('resize', maybeReset)
    vv.addEventListener('scroll', maybeReset)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      vv.removeEventListener('resize', maybeReset)
      vv.removeEventListener('scroll', maybeReset)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
