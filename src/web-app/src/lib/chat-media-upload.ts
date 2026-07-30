/**
 * Portal chat media upload helpers.
 *
 * Phone photos often exceed several MiB; behind Cloudflare / trycloudflare
 * the origin must finish reading the body and respond within ~100s or the
 * edge returns HTTP 524 — which used to surface as a cryptic "upload 524".
 */

import { useAuth } from '@/stores/auth'

/** Compress when larger than this (bytes). */
export const CHAT_MEDIA_COMPRESS_MIN_BYTES = 1_500_000
/** Max longest edge after resize. */
export const CHAT_MEDIA_MAX_EDGE = 2048
/** JPEG quality for recompressed uploads. */
export const CHAT_MEDIA_JPEG_QUALITY = 0.82
/** Client abort before typical CF 100s origin timeout. */
export const CHAT_MEDIA_UPLOAD_TIMEOUT_MS = 90_000

export function formatChatMediaUploadError(
  status: number,
  bodyText: string,
  zh: boolean,
): string {
  if (status === 524 || status === 504 || status === 502) {
    return zh
      ? '上传超时（网关）。经 Cloudflare/隧道时大文件易失败：请压缩图片或换较小文件，或改用局域网直连 Web 控制台。'
      : 'Upload timed out (gateway). Large files often fail behind Cloudflare/tunnels — compress the image, pick a smaller file, or open the console on LAN.'
  }
  const raw = (bodyText || '').trim()
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { code?: string; error?: string; message?: string }
      if (j.code === 'MEDIA_TOO_LARGE') {
        return zh ? '文件过大（上限约 20MB）' : 'File too large (max ~20MB)'
      }
      if (j.code === 'MEDIA_EMPTY') {
        return zh ? '空文件，无法上传' : 'Empty file — nothing to upload'
      }
      if (typeof j.error === 'string' && j.error.trim()) return j.error.trim().slice(0, 200)
      if (typeof j.message === 'string' && j.message.trim()) return j.message.trim().slice(0, 200)
    } catch { /* fall through */ }
  }
  // Cloudflare HTML error pages → strip tags
  const plain = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (plain && !/^error\s*524/i.test(plain)) return plain.slice(0, 200)
  return zh ? `附件上传失败（HTTP ${status}）` : `Attachment upload failed (HTTP ${status})`
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image decode failed'))
    }
    img.src = url
  })
}

/**
 * Downscale / recompress large still images so tunnel uploads finish
 * under gateway timeouts. GIFs and tiny files are left unchanged.
 */
export async function prepareFileForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file
  if (file.type === 'image/gif') return file
  if (file.size <= CHAT_MEDIA_COMPRESS_MIN_BYTES) return file
  if (typeof document === 'undefined') return file

  try {
    const img = await loadImageElement(file)
    const w0 = img.naturalWidth || img.width
    const h0 = img.naturalHeight || img.height
    if (!w0 || !h0) return file

    const scale = Math.min(1, CHAT_MEDIA_MAX_EDGE / Math.max(w0, h0))
    const w = Math.max(1, Math.round(w0 * scale))
    const h = Math.max(1, Math.round(h0 * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(img, 0, 0, w, h)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', CHAT_MEDIA_JPEG_QUALITY)
    })
    if (!blob || blob.size <= 0 || blob.size >= file.size) return file

    const base = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${base}.jpg`, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } catch {
    return file
  }
}

export async function uploadChatMedia(
  file: File,
  threadId: string,
  opts?: { zh?: boolean; signal?: AbortSignal },
): Promise<{ marker: string }> {
  const zh = opts?.zh ?? true
  const prepared = await prepareFileForUpload(file)
  const tok = useAuth.getState().token
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Agim-Filename': encodeURIComponent(prepared.name || 'file'),
    'X-Agim-Mime': prepared.type || 'application/octet-stream',
  }
  if (tok) headers.Authorization = `Bearer ${tok}`

  const ac = new AbortController()
  const timer = window.setTimeout(() => ac.abort(), CHAT_MEDIA_UPLOAD_TIMEOUT_MS)
  const onOuterAbort = (): void => ac.abort()
  opts?.signal?.addEventListener('abort', onOuterAbort)

  try {
    const res = await fetch(`/api/chat/media?threadId=${encodeURIComponent(threadId)}`, {
      method: 'POST',
      headers,
      body: prepared,
      signal: ac.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(formatChatMediaUploadError(res.status, body, zh))
    }
    return res.json() as Promise<{ marker: string }>
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(formatChatMediaUploadError(524, '', zh))
    }
    throw err
  } finally {
    window.clearTimeout(timer)
    opts?.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** Upload all pending attachments; return marker lines for the chat text. */
export async function uploadPendingAttachments(
  items: Array<{ file: File }>,
  threadId: string,
  opts?: { zh?: boolean; signal?: AbortSignal },
): Promise<string[]> {
  const markers: string[] = []
  for (const item of items) {
    const { marker } = await uploadChatMedia(item.file, threadId, opts)
    markers.push(marker)
  }
  return markers
}
