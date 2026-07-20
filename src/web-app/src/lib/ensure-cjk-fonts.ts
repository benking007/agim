/**
 * Explicitly load Agim CJK (Noto Sans SC) via the FontFace API.
 *
 * @font-face in CSS is enough on most browsers, but WKWebView has been
 * observed to keep Chinese as .notdef tofu when the face never settles
 * (e.g. prior /fonts/ 302→login). Calling FontFace.load() forces a real
 * network fetch + registration even if CSS discovery is flaky.
 *
 * unicodeRange is required: without it FontFace claims every code point,
 * including emoji, and WKWebView paints [?]/Agim CJK has no emoji glyphs).
 *
 * Older iOS App builds injected an unrestricted Agim CJK @font-face at
 * document-start. That face cannot be "overridden" by a ranged face of the
 * same family — strip those legacy <style> tags before registering ours.
 */
import { AGIM_CJK_UNICODE_RANGE } from './cjk-unicode-range'

/** Remove injected Agim CJK @font-face rules that omit unicode-range. */
export function stripLegacyUnrestrictedCjkFaces(): number {
  if (typeof document === 'undefined') return 0
  let removed = 0
  for (const el of Array.from(document.querySelectorAll('style'))) {
    const css = el.textContent ?? ''
    if (!/Agim CJK/i.test(css) || !/@font-face/i.test(css)) continue
    if (/unicode-range\s*:/i.test(css)) continue
    el.remove()
    removed += 1
  }
  return removed
}

export function ensureCjkFonts(): void {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  stripLegacyUnrestrictedCjkFaces()
  const faces: Array<{ weight: string; url: string }> = [
    {
      weight: '400',
      url: '/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2',
    },
    {
      weight: '700',
      url: '/fonts/noto-sans-sc-chinese-simplified-700-normal.woff2',
    },
  ]
  for (const face of faces) {
    try {
      const ff = new FontFace(
        'Agim CJK',
        `url(${face.url}) format('woff2')`,
        {
          weight: face.weight,
          style: 'normal',
          display: 'swap',
          unicodeRange: AGIM_CJK_UNICODE_RANGE,
        },
      )
      void ff.load().then((loaded) => {
        document.fonts.add(loaded)
      }).catch(() => {
        /* network / auth / unsupported — CSS @font-face may still win */
      })
    } catch {
      /* FontFace ctor unsupported */
    }
  }
}
