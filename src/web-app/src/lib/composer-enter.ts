/**
 * Composer Enter-key semantics — keyed off shell / browser identity, not viewport.
 *
 * - Agim iOS shell → Enter inserts newline; Send button submits
 * - Agim macOS shell → Enter sends; Ctrl/⌘+Enter newlines
 * - Desktop browser → Enter sends; Ctrl/⌘+Enter newlines
 * - Mobile browser (Safari/Chrome on phone, not Agim shell) → Enter newlines
 */

import {
  getAgimShellPlatform,
  isMobileBrowserUa,
  type AgimShellPlatform,
} from '@/lib/agim-shell'

export interface ComposerEnterClient {
  platform: AgimShellPlatform
  /** Only consulted when platform === 'browser'. */
  mobileBrowser?: boolean
}

export function resolveComposerEnterClient(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
): ComposerEnterClient {
  if (!win) return { platform: 'browser', mobileBrowser: false }
  const platform = getAgimShellPlatform()
  if (platform !== 'browser') return { platform }
  return {
    platform: 'browser',
    mobileBrowser: isMobileBrowserUa(win.navigator?.userAgent ?? ''),
  }
}

/** True when Enter should insert a newline (phone soft-keyboard semantics). */
export function prefersComposerEnterNewline(
  client: ComposerEnterClient = resolveComposerEnterClient(),
): boolean {
  if (client.platform === 'ios') return true
  if (client.platform === 'macos') return false
  // browser
  return Boolean(client.mobileBrowser)
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
