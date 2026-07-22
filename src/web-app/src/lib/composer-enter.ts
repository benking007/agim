/**
 * Composer Enter-key semantics.
 *
 * Desktop (fine pointer / wide viewport): Enter sends; Ctrl/⌘+Enter inserts a newline.
 * Phone / coarse pointer / narrow viewport: Enter inserts a newline; only the Send button submits.
 *
 * Aligns with `MobileChatRedirect` (`max-width: 1023px` → `/m/chat`).
 */

/** Same breakpoint as mobile chat redirect (Tailwind `lg`). */
export const COMPOSER_PHONE_MQ = '(max-width: 1023px)'

export const COMPOSER_COARSE_POINTER_MQ = '(pointer: coarse)'

export function prefersComposerEnterNewline(
  win: Pick<Window, 'matchMedia' | 'innerWidth'> | undefined = typeof window !== 'undefined' ? window : undefined,
): boolean {
  if (!win) return false
  try {
    if (win.matchMedia?.(COMPOSER_PHONE_MQ)?.matches) return true
  } catch { /* ignore */ }
  try {
    // Landscape tablets can be wider than lg but still use a soft keyboard.
    if (win.matchMedia?.(COMPOSER_COARSE_POINTER_MQ)?.matches) return true
  } catch { /* ignore */ }
  // Fallback when matchMedia is stubbed/unavailable (matches mobile-chat-redirect).
  if (typeof win.innerWidth === 'number' && win.innerWidth > 0 && win.innerWidth <= 1023) {
    return true
  }
  return false
}

export interface ComposerEnterKeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * True when this keydown should submit the composer (desktop Enter-to-send).
 * Ctrl/⌘/Shift/Alt+Enter never submit — they insert a newline (or do nothing).
 */
export function shouldSubmitOnEnterKey(
  e: ComposerEnterKeyLike,
  opts: { enterNewline: boolean; isComposing?: boolean },
): boolean {
  if (opts.isComposing) return false
  if (opts.enterNewline) return false
  if (e.key !== 'Enter') return false
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false
  return true
}
