/**
 * Share assistant content via OS share sheet (Phase 1).
 *
 * Portal UI only exposes Share inside Agim native shells (`isAgimNativeShell`).
 * Priority when called:
 * 1. Native — `webkit.messageHandlers.agimShare`
 * 2. Web Share API (`navigator.share`) when available
 * 3. Clipboard copy fallback
 *
 * WeChat / DingTalk / QQ appear as targets inside the system sheet when
 * installed — no OpenSDK. Long text is truncated for the sheet; full body
 * may still ride along as a plain-text file when `canShare({ files })` allows.
 */

export type ShareContentResult = 'native' | 'web' | 'copied' | 'cancelled'

/** Soft cap for share-sheet body text (IM clients often truncate harder). */
export const SHARE_TEXT_MAX = 4_000

export interface ShareContentOptions {
  /** Share sheet title (email subject / card title on some targets). */
  title?: string
  /** Full markdown / plain body. */
  text: string
  /** Optional filename when attaching a file (e.g. `reply.md`). */
  filename?: string
}

/** Truncate for share-sheet text; keeps a single ellipsis when cut. */
export function truncateForShare(text: string, max = SHARE_TEXT_MAX): string {
  const trimmed = text.replace(/\s+$/u, '')
  if (trimmed.length <= max) return trimmed
  if (max <= 1) return '…'
  return `${trimmed.slice(0, max - 1)}…`
}

function buildShareFile(filename: string, content: string): File {
  // `text/plain` is the most widely accepted MIME for OS share targets
  // (iOS often rejects `text/markdown`).
  const name = filename.toLowerCase().endsWith('.md') ? filename : `${filename}.md`
  return new File([content], name, { type: 'text/plain' })
}

/**
 * Open the system share sheet (or copy as fallback).
 * Must be called from a user gesture for Web Share API.
 */
export async function shareContent(opts: ShareContentOptions): Promise<ShareContentResult> {
  const title = (opts.title ?? 'Agim').trim() || 'Agim'
  const full = opts.text
  const text = truncateForShare(full)
  const filename = opts.filename?.trim() || undefined

  const native = window.webkit?.messageHandlers?.agimShare
  if (native) {
    native.postMessage({
      title,
      text,
      filename,
      content: full,
    })
    return 'native'
  }

  if (typeof navigator.share === 'function') {
    let data: ShareData = { title, text }

    if (filename && full.trim()) {
      const file = buildShareFile(filename, full)
      const withFiles: ShareData = { title, text, files: [file] }
      const canFiles = typeof navigator.canShare === 'function'
        ? navigator.canShare(withFiles)
        : false
      if (canFiles) data = withFiles
    }

    const can = typeof navigator.canShare === 'function' ? navigator.canShare(data) : true
    if (can) {
      try {
        await navigator.share(data)
        return 'web'
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
        // Fall through to clipboard.
      }
    }
  }

  await navigator.clipboard.writeText(full)
  return 'copied'
}
