/**
 * Code points Agim CJK (Noto Sans SC subset) is allowed to claim.
 *
 * Must stay in sync with `styles/cjk-font.css` @font-face unicode-range and
 * the iOS WKUserScript in `apps/ios/Agim/Views/WebShellView.swift`.
 *
 * Intentionally excludes emoji / dingbat ranges so Apple Color Emoji (and
 * other system emoji faces) can paint 📋⭐✅ etc. If Agim CJK claims those
 * code points without glyphs, WKWebView shows tofu [?].
 */
export const AGIM_CJK_UNICODE_RANGE = [
  'U+2E80-2EFF', // CJK Radicals Supplement
  'U+2F00-2FDF', // Kangxi Radicals
  'U+3000-303F', // CJK Symbols and Punctuation
  'U+3040-309F', // Hiragana
  'U+30A0-30FF', // Katakana
  'U+3100-312F', // Bopomofo
  'U+31A0-31BF', // Bopomofo Extended
  'U+3400-4DBF', // CJK Ext-A
  'U+4E00-9FFF', // CJK Unified Ideographs
  'U+F900-FAFF', // CJK Compatibility Ideographs
  'U+FF00-FFEF', // Halfwidth/Fullwidth Forms
].join(', ')
