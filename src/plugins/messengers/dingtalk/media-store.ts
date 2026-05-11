// DingTalk inbound media → local disk.
//
// We piggyback on telegram's MEDIA_ROOT so both adapters land their
// attachments in the same ~/.im-hub/media/<platform>/<thread>/ tree.
// That keeps `cleanupOldMedia` (running on the telegram side) covering
// everything, and matches how claude-code's Read tool already expects
// to find adjuncts referenced by `[图片附件：…]` markers.
//
// Why a separate file from `dingtalk-client.ts`? The client's job is the
// network round-trip; the on-disk format and path-injection guards live
// here so they can be unit-tested without spinning up a DWClient.

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MEDIA_ROOT } from '../telegram/media-download.js'

/** Pick a sensible extension for a buffer based on (in order):
 *    1. content-type header from the CDN response
 *    2. the original filename (for msgtype='file') if it has one
 *    3. fallback 'bin' so the file is always inspectable on disk
 *
 *  Same map shape as telegram's pickExtension but DingTalk also delivers
 *  voice as audio/amr — distinct from anything telegram sees. */
export function pickDingTalkExtension(
  contentType: string | undefined,
  originalFilename: string | undefined,
): string {
  if (originalFilename) {
    const m = /\.([a-z0-9]+)$/i.exec(originalFilename)
    if (m) return m[1].toLowerCase()
  }
  if (contentType) {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'audio/amr': 'amr',
      'audio/x-amr': 'amr',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'application/pdf': 'pdf',
    }
    const ct = contentType.toLowerCase().split(';')[0].trim()
    if (map[ct]) return map[ct]
    const m = /\/([a-z0-9]+)$/i.exec(ct)
    if (m) return m[1].toLowerCase()
  }
  return 'bin'
}

/** Write `buffer` to `<MEDIA_ROOT>/dingtalk/<subPath>/<filename>` and
 *  return the absolute path. Refuses path-traversal in filename / subPath
 *  (segments containing `/`, `\`, or `..` are rejected before mkdir).
 *
 *  Caller is responsible for the size cap — `dingtalk-client.ts`
 *  already enforces MAX_MEDIA_BYTES before handing us the buffer. */
export async function saveDingTalkMedia(
  buffer: Buffer,
  subPath: string,
  filename: string,
): Promise<string> {
  for (const piece of [subPath, filename]) {
    if (piece.includes('..') || piece.includes('\\')) {
      throw new Error(`unsafe path piece: ${piece}`)
    }
  }
  if (filename.includes('/')) {
    throw new Error(`unsafe filename: ${filename}`)
  }
  const dir = resolve(MEDIA_ROOT, 'dingtalk', subPath)
  const path = resolve(dir, filename)
  if (!path.startsWith(`${MEDIA_ROOT}/`)) {
    throw new Error(`destination escapes MEDIA_ROOT: ${path}`)
  }
  await mkdir(dir, { recursive: true })
  await writeFile(path, buffer)
  return path
}
