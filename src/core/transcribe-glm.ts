/**
 * Zhipu / GLM audio transcription (GLM-ASR-2512).
 * Docs: https://docs.bigmodel.cn/api-reference/模型-api/语音转文本
 *
 * Env (STT-prefixed — never reuse LLM AGIM_ZHIPU_API_KEY):
 *   AGIM_STT_ZHIPU_API_KEY
 *   AGIM_STT_ZHIPU_BASE_URL   — optional, default https://open.bigmodel.cn/api/paas/v4
 *   AGIM_STT_ZHIPU_MODEL      — optional, default glm-asr-2512
 *
 * Limits (vendor): .wav / .mp3, ≤25 MB, ≤30 s. We convert to 16 kHz WAV.
 */

import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { convertToWav } from './transcribe-audio.js'
import { sttEnv, STT_ENV } from './transcribe-env.js'
import { TranscribeError } from './transcribe-types.js'

const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const DEFAULT_MODEL = 'glm-asr-2512'
const TIMEOUT_MS = 60_000

export function isGlmSpeechConfigured(): boolean {
  return !!sttEnv('zhipuApiKey')
}

export async function transcribeWithGlm(filePath: string, _opts?: { language?: string }): Promise<string> {
  const key = sttEnv('zhipuApiKey')
  if (!key) throw new TranscribeError(`${STT_ENV.zhipuApiKey} not set`, 'glm')

  const baseURL = (sttEnv('zhipuBaseUrl') || DEFAULT_BASE).replace(/\/$/, '')
  const model = sttEnv('zhipuModel') || DEFAULT_MODEL

  const wavPath = join(tmpdir(), `agim-glm-${randomBytes(6).toString('hex')}.wav`)
  try {
    // Vendor accepts wav/mp3 only; Portal often records webm/mp4.
    await convertToWav(filePath, wavPath, 'glm')
    const fileBuf = await readFile(wavPath)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(fileBuf)], { type: 'audio/wav' }), `${basename(filePath, '.webm') || 'audio'}.wav`)
    form.append('model', model)
    form.append('stream', 'false')

    const res = await fetch(`${baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new TranscribeError(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`, 'glm')
    }
    const data = (await res.json()) as { text?: string; error?: { message?: string } }
    if (typeof data.text !== 'string') {
      throw new TranscribeError(data.error?.message || 'response missing text field', 'glm')
    }
    return data.text.trim()
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
