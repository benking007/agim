// WeChat media download helper.
//
// Downloads image / voice / file / video attachments received via iLink to
// ~/.agim/media/wechat/<userId>/<msgId>.<ext> so downstream agents can
// read them by path (same convention as the Telegram adapter).
//
// Cleanup: shares MEDIA_ROOT and the same TTL-based sweep as
// telegram/media-download.ts (both write into the same root dir).

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { logger as rootLogger } from '../../../core/logger.js'
import { AGIM_HOME } from '../../../core/agim-paths.js'
import type { CDNMedia, ImageItem, VoiceItem, FileItem, VideoItem } from './ilink-types.js'
import type { ILinkClient } from './ilink-client.js'

const log = rootLogger.child({ component: 'wechat.media' })

export const MEDIA_ROOT: string = resolve(
  process.env.AGIM_MEDIA_ROOT ?? join(AGIM_HOME, 'media'),
)

export const MAX_BYTES = 20 * 1024 * 1024

export interface WechatDownloadResult {
  path: string
  bytes: number
}

/**
 * Download a CDN media blob via the iLink client and write it to
 * `MEDIA_ROOT/wechat/<subdir>/<filename>`. Returns the absolute path.
 * The AES key is read from `cdnMedia.aes_key` (base64 of an ASCII hex string).
 */
export async function downloadWechatMedia(
  client: ILinkClient,
  cdnMedia: CDNMedia,
  subdir: string,
  filename: string,
): Promise<WechatDownloadResult> {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new Error(`unsafe filename: ${filename}`)
  }

  const dir = resolve(MEDIA_ROOT, 'wechat', subdir)
  const filePath = resolve(dir, filename)
  if (!filePath.startsWith(`${MEDIA_ROOT}/`)) {
    throw new Error(`destination escapes MEDIA_ROOT: ${filePath}`)
  }

  const buf = await client.downloadMedia(cdnMedia)
  if (buf.length > MAX_BYTES) {
    throw new Error(`payload exceeds ${MAX_BYTES} bytes (got ${buf.length})`)
  }

  await mkdir(dir, { recursive: true })
  await writeFile(filePath, buf)

  log.info({ event: 'wechat.media.downloaded', path: filePath, bytes: buf.length })
  return { path: filePath, bytes: buf.length }
}

/**
 * Pick a file extension based on the media item contents. Falls back to a
 * generic extension when nothing more specific can be inferred.
 */
export function pickExtensionForImage(item: ImageItem): string {
  if (item.url) {
    const m = /\.([a-z0-9]+)$/i.exec(item.url.split('?')[0])
    if (m) return m[1].toLowerCase()
  }
  return 'jpg'
}

export function pickExtensionForVoice(item: VoiceItem): string {
  if (item.encode_type === 6) return 'silk'
  return 'amr'
}

export function pickExtensionForFile(item: FileItem): string {
  if (item.file_name) {
    const m = /\.([a-z0-9]+)$/i.exec(item.file_name)
    if (m) return m[1].toLowerCase()
  }
  return 'bin'
}

export function pickExtensionForVideo(_item: VideoItem): string {
  return 'mp4'
}

/**
 * Resolve the CDNMedia reference from a media item. Returns null when the
 * item lacks the signed CDN URL or its AES key. The bot fetches
 * `media.full_url` directly and decrypts with `media.aes_key` (no iLink-side
 * download endpoint exists).
 */
export function extractCdnMedia(
  item: { media?: CDNMedia },
): CDNMedia | null {
  if (!item.media?.full_url || !item.media?.aes_key) return null
  return item.media
}
