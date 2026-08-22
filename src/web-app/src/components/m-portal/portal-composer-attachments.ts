/**
 * Pending composer attachments — shared by the "+" picker and clipboard paste.
 */

export const MAX_PENDING_ATTACHMENTS = 8

export interface PendingAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  previewUrl?: string
  /** Local File until uploaded at send time. */
  file: File
}

const GENERIC_CLIPBOARD_NAME = /^(image|blob|untitled|screenshot)(\.\w+)?$/i

function extFromMime(mime: string): string | undefined {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  }
  return map[mime.toLowerCase()]
}

function extFromName(name: string): string | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m?.[1]?.toLowerCase()
}

export function isGenericClipboardName(name: string): boolean {
  const n = name.trim()
  return n.length === 0 || GENERIC_CLIPBOARD_NAME.test(n)
}

export function screenshotFileName(file: File, now = new Date()): string {
  const ext = extFromMime(file.type) || extFromName(file.name) || 'png'
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `screenshot-${stamp}.${ext}`
}

function looksLikeImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(name)
}

export function isClipboardImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  if (file.type) return false
  return looksLikeImageName(file.name) || isGenericClipboardName(file.name)
}

/** Give screenshot blobs a stable, upload-friendly filename. */
export function normalizeClipboardImage(file: File, now = new Date()): File {
  if (!isGenericClipboardName(file.name)) return file
  const name = screenshotFileName(file, now)
  return new File([file], name, {
    type: file.type || 'image/png',
    lastModified: file.lastModified,
  })
}

/** Images from a paste event (OS screenshot, copied photo). Text-only pastes return []. */
export function filesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  const out: File[] = []

  if (data.items && data.items.length > 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue
      if (item.type && !item.type.startsWith('image/')) continue
      const raw = item.getAsFile()
      if (!raw || !isClipboardImageFile(raw)) continue
      out.push(normalizeClipboardImage(raw))
    }
  }

  if (out.length === 0 && data.files && data.files.length > 0) {
    for (const raw of Array.from(data.files)) {
      if (!isClipboardImageFile(raw)) continue
      out.push(normalizeClipboardImage(raw))
    }
  }

  return out
}

export function appendPendingFiles(
  existing: PendingAttachment[],
  list: ArrayLike<File> | null | undefined,
  preferImage: boolean,
): { next: PendingAttachment[]; overflowed: boolean } {
  if (!list || list.length === 0) return { next: existing, overflowed: false }
  const next = [...existing]
  let overflowed = false
  for (let i = 0; i < list.length; i++) {
    const file = list[i]
    if (!file) continue
    if (next.length >= MAX_PENDING_ATTACHMENTS) {
      overflowed = true
      break
    }
    const isImage = preferImage || file.type.startsWith('image/')
    const previewUrl = isImage ? URL.createObjectURL(file) : undefined
    next.push({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: isImage ? 'image' : 'file',
      name: file.name || (isImage ? 'image.jpg' : 'file'),
      mime: file.type || 'application/octet-stream',
      previewUrl,
      file,
    })
  }
  return { next, overflowed }
}

/** Apply a paste: if clipboard has images, attach them like the "+" photo picker. */
export function consumeClipboardImages(
  clipboardData: DataTransfer | null | undefined,
  existing: PendingAttachment[],
): { next: PendingAttachment[]; overflowed: boolean; consumed: boolean } {
  const files = filesFromClipboard(clipboardData)
  if (files.length === 0) {
    return { next: existing, overflowed: false, consumed: false }
  }
  const { next, overflowed } = appendPendingFiles(existing, files, true)
  return { next, overflowed, consumed: true }
}
