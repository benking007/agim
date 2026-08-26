/**
 * Web chat media uploads — same on-disk convention as IM adapters so
 * agents can Read `[图片附件：…]` / `[文件附件：…]` markers.
 *
 * Files land under `~/.agim/media/web/<safeThreadId>/`.
 */

import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
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

async function prepareWebMediaPath(opts: {
  threadId: string
  filename: string
  mime: string
}): Promise<{ abs: string; mime: string; safeName: string }> {
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
  return { abs, mime, safeName }
}

function savedFromDisk(abs: string, bytes: number, mime: string, safeName: string): SavedWebMedia {
  const kind: 'image' | 'file' = mime.startsWith('image/') ? 'image' : 'file'
  log.info({ path: abs, bytes, mime, kind }, 'web chat media saved')
  return { path: abs, bytes, mime, name: safeName, kind }
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
  const dest = await prepareWebMediaPath(opts)
  await writeFile(dest.abs, opts.body)
  return savedFromDisk(dest.abs, opts.body.byteLength, dest.mime, dest.safeName)
}

/** Stream the request body to disk so a 20 MiB upload is not held twice in RAM. */
export async function saveWebChatMediaFromStream(opts: {
  threadId: string
  filename: string
  mime: string
  source: NodeJS.ReadableStream
  maxBytes?: number
}): Promise<SavedWebMedia> {
  const maxBytes = opts.maxBytes ?? WEB_MEDIA_MAX_BYTES
  const dest = await prepareWebMediaPath(opts)
  let bytes = 0
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(dest.abs)
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        opts.source.unpipe?.(out)
        if ('destroy' in opts.source && typeof opts.source.destroy === 'function') {
          opts.source.destroy()
        }
        out.destroy()
        reject(err)
      }
      opts.source.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          fail(Object.assign(new Error('file too large'), { code: 'TOO_LARGE' }))
        }
      })
      opts.source.on('error', fail)
      out.on('error', fail)
      out.on('finish', () => {
        if (!settled) {
          settled = true
          resolve()
        }
      })
      opts.source.pipe(out)
    })
  } catch (err) {
    await unlink(dest.abs).catch(() => {})
    throw err
  }
  if (bytes === 0) {
    await unlink(dest.abs).catch(() => {})
    throw Object.assign(new Error('empty body'), { code: 'EMPTY' })
  }
  return savedFromDisk(dest.abs, bytes, dest.mime, dest.safeName)
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

function realpathSyncSoft(abs: string): string {
  try {
    return realpathSync(abs)
  } catch {
    // File may not exist yet — resolve parent when possible.
    const lastSep = abs.lastIndexOf(sep)
    if (lastSep <= 0) return abs
    try {
      return join(realpathSync(abs.slice(0, lastSep)), abs.slice(lastSep + 1))
    } catch {
      return abs
    }
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(rootWithSep)
}

/**
 * Resolve a media path for GET /api/chat/media/file.
 * Lexical resolve + realpath (symlink escape) must stay under a media root.
 * When `threadId` is provided, path must live under `…/web/<sanitized>/`.
 */
export function resolveSafeWebMediaPath(
  requested: string,
  opts?: { threadId?: string },
): string | null {
  const raw = (requested || '').trim()
  if (!raw) return null
  const abs = resolve(raw)
  const real = realpathSyncSoft(abs)
  const roots = [getWebMediaRoot(), resolve(join(AGIM_HOME, 'media')), resolve(join(homedir(), '.agim', 'media'))]
    .map((r) => realpathSyncSoft(r))
  const matchedRoot = roots.find((root) => isInsideRoot(root, real) || isInsideRoot(root, abs))
  if (!matchedRoot) return null
  if (opts?.threadId) {
    const sub = join('web', sanitizeThreadId(opts.threadId))
    const threadRoot = realpathSyncSoft(resolve(matchedRoot, sub))
    if (!isInsideRoot(threadRoot, real) && !isInsideRoot(threadRoot, abs)) return null
  }
  return real
}

/** Async variant used when callers already await (tests / future). */
export async function resolveSafeWebMediaPathAsync(
  requested: string,
  opts?: { threadId?: string },
): Promise<string | null> {
  const raw = (requested || '').trim()
  if (!raw) return null
  const abs = resolve(raw)
  let real = abs
  try { real = await realpath(abs) } catch { /* keep abs */ }
  const rootCandidates = [getWebMediaRoot(), resolve(join(AGIM_HOME, 'media')), resolve(join(homedir(), '.agim', 'media'))]
  const roots: string[] = []
  for (const r of rootCandidates) {
    try { roots.push(await realpath(r)) } catch { roots.push(r) }
  }
  const matchedRoot = roots.find((root) => isInsideRoot(root, real) || isInsideRoot(root, abs))
  if (!matchedRoot) return null
  if (opts?.threadId) {
    const threadRoot = resolve(matchedRoot, 'web', sanitizeThreadId(opts.threadId))
    let realThread = threadRoot
    try { realThread = await realpath(threadRoot) } catch { /* keep */ }
    if (!isInsideRoot(realThread, real) && !isInsideRoot(realThread, abs)) return null
  }
  return real
}

/** Guess a Content-Type from filename when the on-disk mime is unknown.
 *  HTML / SVG / XML are never served as their native types — browsers
 *  would execute them as a stored XSS when Content-Disposition is inline. */
export function guessMediaContentType(filename: string): string {
  const lower = basename(filename).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain; charset=utf-8'
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js')
    || lower.endsWith('.jsx') || lower.endsWith('.css')
    || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'text/plain; charset=utf-8'
  }
  return 'application/octet-stream'
}

const UNSAFE_INLINE_EXT = /\.(html?|svg|xml)$/i

/** True when the file must not be rendered inline by the browser. */
export function isUnsafeInlineMedia(filename: string): boolean {
  return UNSAFE_INLINE_EXT.test(basename(filename))
}

export function mediaContentDisposition(filename: string): string {
  const name = basename(filename).replace(/"/g, '_')
  const disp = isUnsafeInlineMedia(filename) ? 'attachment' : 'inline'
  return `${disp}; filename="${name}"`
}

/** Replay headers that block MIME sniffing and script execution. */
export const MEDIA_SAFE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'sandbox',
}
