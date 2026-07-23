/**
 * Portal / Web hold-to-talk STT — wrap core `transcribe()` for HTTP uploads.
 *
 * Writes the raw audio blob to a temp file (Whisper needs a path + extension),
 * runs the configured provider, then deletes the temp file.
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import {
  detectProvider,
  STT_NOT_CONFIGURED_HINT,
  transcribe,
  TranscribeError,
  type TranscribeProvider,
  type TranscribeResult,
} from './transcribe.js'

/** ~60s of opus/webm or aac/mp4 at conversational bitrate. */
export const CHAT_TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024

const MIME_EXT: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/webm;codecs=opus': '.webm',
  'audio/ogg': '.ogg',
  'audio/ogg;codecs=opus': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
}

export function extensionForAudioMime(mime: string, filename?: string): string {
  const fromName = filename ? extname(filename).toLowerCase() : ''
  if (fromName && /^\.(webm|ogg|m4a|mp3|wav|aac|mp4)$/.test(fromName)) return fromName
  const key = (mime || '').toLowerCase().trim()
  if (MIME_EXT[key]) return MIME_EXT[key]
  const base = key.split(';')[0]?.trim() ?? ''
  if (MIME_EXT[base]) return MIME_EXT[base]
  return '.webm'
}

export async function transcribeChatAudio(opts: {
  body: Buffer
  mime?: string
  filename?: string
  language?: string
}): Promise<TranscribeResult> {
  if (!opts.body.length) {
    throw new TranscribeError('empty audio body', detectProvider())
  }
  if (opts.body.length > CHAT_TRANSCRIBE_MAX_BYTES) {
    throw Object.assign(
      new TranscribeError(`audio exceeds ${CHAT_TRANSCRIBE_MAX_BYTES} bytes`, detectProvider()),
      { code: 'TOO_LARGE' as const },
    )
  }
  if (detectProvider() === 'none') {
    throw new TranscribeError(STT_NOT_CONFIGURED_HINT, 'none')
  }

  const dir = await mkdtemp(join(tmpdir(), 'agim-chat-stt-'))
  const ext = extensionForAudioMime(opts.mime || '', opts.filename)
  const path = join(dir, `clip-${randomBytes(6).toString('hex')}${ext}`)
  try {
    await writeFile(path, opts.body)
    // Omit provider so Auto mode can fail over across configured vendors.
    return await transcribe(path, {
      language: opts.language || 'zh',
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function isTranscribeConfigured(): boolean {
  return detectProvider() !== 'none'
}

export type { TranscribeProvider, TranscribeResult }
