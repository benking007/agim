/**
 * Pin a full-screen mobile shell to the *visual* viewport.
 *
 * On iOS WKWebView / Safari, focusing a bottom input pans the layout so
 * `visualViewport.offsetTop > 0` and the top chrome scrolls off-screen —
 * even when `html/body` are `position: fixed`. Binding `top` + `height` to
 * the visual viewport keeps the header sticky in the visible frame and
 * naturally parks the composer above the soft keyboard.
 */

import { useEffect, useState, type CSSProperties } from 'react'

export interface PortalViewportFrame {
  /** Apply to the portal root shell. */
  style: CSSProperties
  /** Pixels of bottom overlap (keyboard); usually 0 when style.height
   *  already tracks visualViewport.height — exposed for callers that
   *  still pad absolute footers. */
  keyboardInset: number
}

export function usePortalViewportFrame(): PortalViewportFrame {
  const [frame, setFrame] = useState(() => ({
    top: 0,
    left: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
    keyboardInset: 0,
  }))

  useEffect(() => {
    const vv = window.visualViewport

    const update = (): void => {
      if (!vv) {
        setFrame({
          top: 0,
          left: 0,
          width: window.innerWidth,
          height: window.innerHeight,
          keyboardInset: 0,
        })
        return
      }
      const obscured = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      setFrame({
        top: vv.offsetTop,
        // Bind left/width to visualViewport so residual zoom / sideways
        // visual pan cannot leave a wider layout surface to drag.
        left: vv.offsetLeft,
        width: vv.width,
        height: vv.height,
        keyboardInset: obscured > 24 ? Math.round(obscured) : 0,
      })
    }

    update()
    if (!vv) {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return {
    style: {
      position: 'fixed',
      top: frame.top,
      left: frame.left,
      width: frame.width,
      height: frame.height,
      maxWidth: '100%',
      overflowX: 'hidden',
    },
    keyboardInset: frame.keyboardInset,
  }
}
