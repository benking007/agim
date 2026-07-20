/**
 * Save plain text as a local file with a Save-As experience where possible.
 *
 * Portal UI only exposes Save in the browser (`!isAgimNativeShell`). Priority:
 * 1. Native Agim shells (iOS / macOS WKWebView) via `webkit.messageHandlers.agimSaveFile` (unused by UI)
 * 2. File System Access API (`showSaveFilePicker`) — Chromium desktop “Save As”
 * 3. Anchor `download` fallback (Safari / Firefox / locked-down contexts)
 */

export type SaveTextAsFileResult = 'native' | 'picker' | 'download' | 'cancelled'

export interface SaveTextAsFileOptions {
  filename: string
  content: string
  mime?: string
}

type AgimSavePayload = {
  filename: string
  content: string
  mime: string
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        agimSaveFile?: { postMessage: (msg: AgimSavePayload) => void }
        /** OS share sheet (iOS / macOS shells). Payload: title/text/filename/content. */
        agimShare?: { postMessage: (msg: Record<string, unknown>) => void }
      }
    }
    showSaveFilePicker?: (options?: {
      suggestedName?: string
      types?: Array<{
        description?: string
        accept: Record<string, string[]>
      }>
    }) => Promise<{
      createWritable: () => Promise<{
        write: (data: string | Blob) => Promise<void>
        close: () => Promise<void>
      }>
    }>
  }
}

/** Build a safe `*.md` name from the first non-empty line + timestamp. */
export function markdownFilenameFromContent(content: string, now = new Date()): string {
  const first = content.split('\n').find((l) => l.trim())?.trim() ?? ''
  const slug = first
    .replace(/^#+\s*/, '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const base = slug || 'agim-reply'
  return `${base}-${stamp}.md`
}

function downloadViaAnchor(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on next tick so the download pipeline can read the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/**
 * Prompt the user to save `content` as `filename`.
 * Resolves with the strategy used (or `cancelled` if the user dismissed a picker).
 */
export async function saveTextAsFile(opts: SaveTextAsFileOptions): Promise<SaveTextAsFileResult> {
  const mime = opts.mime ?? 'text/markdown;charset=utf-8'
  const filename = opts.filename.trim() || 'agim-reply.md'
  const content = opts.content

  const native = window.webkit?.messageHandlers?.agimSaveFile
  if (native) {
    native.postMessage({ filename, content, mime })
    return 'native'
  }

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Markdown',
            accept: { 'text/markdown': ['.md'], 'text/plain': ['.md', '.txt'] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(content)
      await writable.close()
      return 'picker'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
      // Fall through to download (permissions / unsupported).
    }
  }

  downloadViaAnchor(filename, content, mime)
  return 'download'
}
