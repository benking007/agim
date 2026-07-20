/**
 * Detect Agim native shells (iOS / macOS WKWebView) vs plain browser.
 *
 * Shells register custom `webkit.messageHandlers` (`agimShare`, `agimSaveFile`).
 * Safari/Chrome alone have `window.webkit` in some cases but never these handlers.
 */

export function isAgimNativeShell(): boolean {
  const handlers = typeof window !== 'undefined'
    ? window.webkit?.messageHandlers
    : undefined
  return Boolean(handlers?.agimShare || handlers?.agimSaveFile)
}
