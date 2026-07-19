/**
 * Soften punctuation / emoji that paints as tofu ([?] / □) when an older
 * iOS WKUserScript registered Agim CJK without unicode-range (that face
 * claims every code point but has no emoji / Latin-1 glyph coverage).
 *
 * Prefer fixing the font stack (ensure-cjk-fonts + WebShellView). This is
 * defense-in-depth for toast / status lines that still ship fancy glyphs.
 */
export function sanitizeDisplayText(text: string): string {
  return text
    .replace(/\u00B7/g, '|') // ·
    .replace(/\u2022/g, '|') // •
    .replace(/\u2192/g, '->') // →
    .replace(/\u2190/g, '<-') // ←
    .replace(/\u21D2/g, '=>') // ⇒
    .replace(/\u2026/g, '...') // …
    .replace(/[\u2013\u2014\u2015]/g, '-') // – — ―
    .replace(/\u266A/g, '!') // ♪
    .replace(/\u301C/g, '~') // 〜
    // Emoji + dingbats / misc symbols commonly used in IM approval copy.
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
