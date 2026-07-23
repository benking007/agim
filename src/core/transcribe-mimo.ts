/**
 * Xiaomi MiMo speech recognition (MiMo-V2.5-ASR).
 * Docs: https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition
 *
 * Unlike Whisper-style /audio/transcriptions, MiMo exposes ASR via
 * POST /v1/chat/completions with an input_audio content part.
 *
 * Env:
 *   AGIM_MIMO_API_KEY           — preferred; falls back to MIMO_API_KEY
 *   AGIM_MIMO_BASE_URL          — optional, default https://api.xiaomimimo.com/v1
 *   AGIM_MIMO_TRANSCRIBE_MODEL  — optional, default mimo-v2.5-asr
 *
 * Limits (vendor): wav/mp3; Base64 payload ≤ 10 MB. We convert to 16 kHz WAV.
 */

import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { convertToWav } from './transcribe-audio.js'
import { TranscribeError } from './transcribe-types.js'

const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1'
const DEFAULT_MODEL = 'mimo-v2.5-asr'
const TIMEOUT_MS = 60_000
/** Vendor cap is 10 MB on the Base64 string (~7.5 MB raw). */
const MAX_RAW_BYTES = 7 * 1024 * 1024

function resolveApiKey(): string | undefined {
  return process.env.AGIM_MIMO_API_KEY?.trim() || process.env.MIMO_API_KEY?.trim() || undefined
}

export function isMimoSpeechConfigured(): boolean {
  return !!resolveApiKey()
}

function resolveLanguage(opts?: { language?: string }): 'auto' | 'zh' | 'en' {
  const lang = (opts?.language || '').toLowerCase()
  if (lang.startsWith('zh') || lang === 'cn' || lang === 'yue') return 'zh'
  if (lang.startsWith('en')) return 'en'
  return 'auto'
}

export async function transcribeWithMimo(filePath: string, opts?: { language?: string }): Promise<string> {
  const key = resolveApiKey()
  if (!key) throw new TranscribeError('AGIM_MIMO_API_KEY (or MIMO_API_KEY) not set', 'mimo')

  const baseURL = (process.env.AGIM_MIMO_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/$/, '')
  const model = process.env.AGIM_MIMO_TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL

  const wavPath = join(tmpdir(), `agim-mimo-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath, 'mimo')
    const fileBuf = await readFile(wavPath)
    if (fileBuf.length > MAX_RAW_BYTES) {
      throw new TranscribeError(
        `audio too large for MiMo ASR (${fileBuf.length} bytes; limit ~${MAX_RAW_BYTES})`,
        'mimo',
      )
    }
    const b64 = fileBuf.toString('base64')
    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: `data:audio/wav;base64,${b64}`,
              },
            },
          ],
        },
      ],
      asr_options: {
        language: resolveLanguage(opts),
      },
      stream: false,
    }

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'api-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new TranscribeError(`HTTP ${res.status} ${res.statusText}: ${errBody.slice(0, 200)}`, 'mimo')
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
      error?: { message?: string }
    }
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      throw new TranscribeError(data.error?.message || 'response missing transcript content', 'mimo')
    }
    return text.trim()
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
