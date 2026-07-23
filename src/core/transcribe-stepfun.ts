/**
 * StepFun / 阶跃星辰 StepAudio 2.5 ASR.
 * Docs: https://platform.stepfun.com/docs/zh/guides/models/stepaudio-2.5-asr
 * API:  https://platform.stepfun.com/docs/zh/api-reference/audio/transcriptions
 *
 * Sync multipart upload (OpenAI-compatible shape):
 *   POST {base}/audio/transcriptions
 *   model=stepaudio-2.5-asr, response_format=json, file=<audio>
 *
 * Env:
 *   AGIM_STEPFUN_API_KEY           — STT-only. Do NOT reuse STEPFUN_API_KEY from LLM
 *                                    (that vendor env is for chat backends and would
 *                                    falsely mark ASR as "configured").
 *   AGIM_STEPFUN_BASE_URL          — optional, default https://api.stepfun.com/v1
 *   AGIM_STEPFUN_TRANSCRIBE_MODEL  — optional, default stepaudio-2.5-asr
 *
 * Vendor accepts mp3 / pcm / ogg / wav (<100 MB). We convert to 16 kHz WAV.
 */

import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { convertToWav } from './transcribe-audio.js'
import { TranscribeError } from './transcribe-types.js'

const DEFAULT_BASE = 'https://api.stepfun.com/v1'
const DEFAULT_MODEL = 'stepaudio-2.5-asr'
const TIMEOUT_MS = 60_000

function resolveApiKey(): string | undefined {
  // Intentionally STT-scoped. LLM secrets may export STEPFUN_API_KEY for
  // chat backends; sharing that here made /settings/stt show StepFun ASR as
  // "configured / in use" even when the operator never set up speech.
  return process.env.AGIM_STEPFUN_API_KEY?.trim() || undefined
}

export function isStepfunSpeechConfigured(): boolean {
  return !!resolveApiKey()
}

export async function transcribeWithStepfun(filePath: string, _opts?: { language?: string }): Promise<string> {
  const key = resolveApiKey()
  if (!key) {
    throw new TranscribeError('AGIM_STEPFUN_API_KEY not set', 'stepfun')
  }

  const baseURL = (process.env.AGIM_STEPFUN_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/$/, '')
  const model = process.env.AGIM_STEPFUN_TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL

  const wavPath = join(tmpdir(), `agim-stepfun-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath, 'stepfun')
    const fileBuf = await readFile(wavPath)
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(fileBuf)], { type: 'audio/wav' }),
      `${basename(filePath, '.webm') || 'audio'}.wav`,
    )
    form.append('model', model)
    form.append('response_format', 'json')

    const res = await fetch(`${baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new TranscribeError(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`, 'stepfun')
    }

    const data = (await res.json()) as { text?: string; error?: { message?: string } }
    if (typeof data.text !== 'string') {
      throw new TranscribeError(data.error?.message || 'response missing text field', 'stepfun')
    }
    return data.text.trim()
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
