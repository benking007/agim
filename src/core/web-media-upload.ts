/**
 * Web chat media uploads — same on-disk convention as IM adapters so
 * agents can Read `[图片附件：…]` / `[文件附件：…]` markers.
 *
 * Files land under `~/.agim/media/web/<safeThreadId>/`.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'web.media' })

export const WEB_MEDIA_MAX_BYTES = 20 * 1024 * 1024

export function getWebMediaRoot(): string {
  return resolve(process.env.AGIM_MEDIA_ROOT ?? join(AGIM_HOME, 'media'))
}

function sanitizeThreadId(threadId: string): string {
  const cleaned = threadId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80)
  return cleaned || 'anon'
}

function sanitizeFilename(name: string): string {
  const base = basename(name || 'file').replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
  return (base || 'file').slice(0, 120)
}

function pickExt(filename: string, mime: string): string {
  const fromName = extname(filename)
  if (fromName && fromName.length <= 8) return fromName
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'application/pdf') return '.pdf'
  return ''
}

export interface SavedWebMedia {
  path: string
  bytes: number
  mime: string
  name: string
  kind: 'image' | 'file'
}

export async function saveWebChatMedia(opts: {
  threadId: string
  filename: string
  mime: string
  body: Buffer
}): Promise<SavedWebMedia> {
  if (opts.body.byteLength === 0) {
    throw Object.assign(new Error('empty body'), { code: 'EMPTY' })
  }
  if (opts.body.byteLength > WEB_MEDIA_MAX_BYTES) {
    throw Object.assign(new Error('file too large'), { code: 'TOO_LARGE' })
  }

  const root = getWebMediaRoot()
  const subdir = join('web', sanitizeThreadId(opts.threadId))
  const dir = join(root, subdir)
  await mkdir(dir, { recursive: true })

  const mime = (opts.mime || 'application/octet-stream').slice(0, 120)
  const safeName = sanitizeFilename(opts.filename)
  const ext = pickExt(safeName, mime)
  const stem = safeName.replace(/\.[^.]+$/, '') || 'file'
  const stored = `${Date.now()}-${randomBytes(4).toString('hex')}-${stem}${ext}`
  const abs = resolve(join(dir, stored))
  if (!abs.startsWith(root)) {
    throw Object.assign(new Error('path escape'), { code: 'PATH' })
  }

  await writeFile(abs, opts.body)
  const kind: 'image' | 'file' = mime.startsWith('image/') ? 'image' : 'file'
  log.info({ path: abs, bytes: opts.body.byteLength, mime, kind }, 'web chat media saved')
  return {
    path: abs,
    bytes: opts.body.byteLength,
    mime,
    name: safeName,
    kind,
  }
}

export function formatMediaMarker(saved: SavedWebMedia): string {
  if (saved.kind === 'image') return `[图片附件：${saved.path}]`
  const sizeStr = saved.bytes < 1024
    ? `${saved.bytes} B`
    : saved.bytes < 1024 * 1024
      ? `${(saved.bytes / 1024).toFixed(1)} KB`
      : `${(saved.bytes / (1024 * 1024)).toFixed(1)} MB`
  return `[文件附件：${saved.path} (${saved.name}, ${sizeStr})]`
}

/**
 * Resolve a client-supplied absolute path only if it is a real file under
 * the web media root (prevents path traversal outside ~/.agim/media).
 */
export function resolveSafeWebMediaPath(requested: string): string | null {
  const raw = (requested || '').trim()
  if (!raw) return null
  const root = getWebMediaRoot()
  const abs = resolve(raw)
  const rootWithSep = root.endsWith('/') ? root : `${root}/`
  if (abs !== root && !abs.startsWith(rootWithSep)) return null
  return abs
}

/** Guess a Content-Type from filename when the on-disk mime is unknown. */
export function guessMediaContentType(filename: string): string {
  const lower = basename(filename).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain; charset=utf-8'
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js')
    || lower.endsWith('.jsx') || lower.endsWith('.css') || lower.endsWith('.xml')
    || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'text/plain; charset=utf-8'
  }
  return 'application/octet-stream'
}
