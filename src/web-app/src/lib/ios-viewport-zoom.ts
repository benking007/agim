/**
 * Reset a stuck iOS Safari page zoom without permanently locking pinch-zoom.
 *
 * When a focused input is under 16px (or Safari otherwise auto-zooms), the
 * visual viewport can stay scaled after blur. Temporarily setting
 * maximum-scale=1 snaps scale back to 1; restoring the prior meta content
 * keeps pinch-zoom available.
 */

const VIEWPORT_META = 'meta[name="viewport"]'

export function resetIosViewportZoom(): void {
  if (typeof document === 'undefined') return
  const vv = window.visualViewport
  if (vv && vv.scale <= 1.01) return

  const meta = document.querySelector(VIEWPORT_META)
  if (!meta) return

  const prev = meta.getAttribute('content') ?? ''
  const locked = /maximum-scale\s*=/i.test(prev)
    ? prev.replace(/maximum-scale\s*=\s*[^,]+/i, 'maximum-scale=1')
    : `${prev}, maximum-scale=1`
  meta.setAttribute('content', locked)

  // Restore on the next frame so accessibility pinch-zoom remains available.
  requestAnimationFrame(() => {
    meta.setAttribute('content', prev)
  })
}
