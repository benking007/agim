/**
 * Explicitly load Agim CJK (Noto Sans SC) via the FontFace API.
 *
 * @font-face in CSS is enough on most browsers, but WKWebView has been
 * observed to keep Chinese as .notdef tofu when the face never settles
 * (e.g. prior /fonts/ 302→login). Calling FontFace.load() forces a real
 * network fetch + registration even if CSS discovery is flaky.
 */
export function ensureCjkFonts(): void {
  if (typeof document === 'undefined' || !('fonts' in document)) return
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
        { weight: face.weight, style: 'normal', display: 'swap' },
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
