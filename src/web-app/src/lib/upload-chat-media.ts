/**
 * Portal attachment upload — compress photos, bound the wait, retry
 * once on gateway timeouts so a single 524 does not look like a
 * successful send.
 */

import i18n from '@/i18n'
import { useAuth } from '@/stores/auth'
import { compressImageForUpload } from './compress-image'
import type { PendingAttachment } from '@/components/m-portal/portal-composer-attachments'

export const UPLOAD_TIMEOUT_MS = 75_000
export const UPLOAD_CONCURRENCY = 2

export function formatUploadError(status: number, body: string): string {
  const snippet = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180)
  if (status === 524 || /524|cloudflare/i.test(body)) {
    return i18n.t('chat.portal.attach.uploadCloudflare', {
      defaultValue: 'Gateway timeout (524). The image is too large or the network is too slow.',
    })
  }
  if (status === 408 || status === 504) {
    return i18n.t('chat.portal.attach.uploadTimeout', {
      defaultValue: 'Upload timed out. Try a smaller image or a more stable network.',
    })
  }
  return snippet || `upload ${status}`
}

export async function uploadChatMedia(file: File, threadId: string): Promise<{ marker: string }> {
  const payload = await compressImageForUpload(file)
  const tok = useAuth.getState().token
  const headers: Record<string, string> = {
    'Content-Type': payload.type || 'application/octet-stream',
    'X-Agim-Filename': encodeURIComponent(payload.name || 'file'),
    'X-Agim-Mime': payload.type || 'application/octet-stream',
  }
  if (tok) headers.Authorization = `Bearer ${tok}`

  let lastErr: Error | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), UPLOAD_TIMEOUT_MS)
    try {
      const res = await fetch(`/api/chat/media?threadId=${encodeURIComponent(threadId)}`, {
        method: 'POST',
        headers,
        body: payload,
        signal: ac.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(formatUploadError(res.status, body))
        const retryable = res.status === 524 || res.status === 502 || res.status === 503 || res.status === 504
        if (retryable && attempt === 0) {
          lastErr = err
          continue
        }
        throw err
      }
      return res.json() as Promise<{ marker: string }>
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        lastErr = new Error(i18n.t('chat.portal.attach.uploadTimeout', {
          defaultValue: 'Upload timed out. Try a smaller image or a more stable network.',
        }))
        if (attempt === 0) continue
        throw lastErr
      }
      if (err instanceof Error && attempt === 0 && /524|Failed to fetch|network/i.test(err.message)) {
        lastErr = err
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error(i18n.t('chat.portal.attach.uploadFailed', { defaultValue: 'Attachment upload failed' }))
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next
      next += 1
      out[i] = await fn(items[i] as T)
    }
  }
  const n = Math.min(Math.max(1, limit), items.length || 1)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

/** Upload all pending attachments; return marker lines for the chat text. */
export async function uploadPendingAttachments(
  items: PendingAttachment[],
  threadId: string,
): Promise<string[]> {
  if (items.length === 0) return []
  const markers = await mapPool(items, UPLOAD_CONCURRENCY, async (item) => {
    const { marker } = await uploadChatMedia(item.file, threadId)
    return marker
  })
  return markers
}
