/**
 * Baidu short speech recognition (≤60s).
 * Docs: https://ai.baidu.com/ai-doc/SPEECH/Jlbxdezuf
 *
 * Env (STT-prefixed):
 *   AGIM_STT_BAIDU_API_KEY
 *   AGIM_STT_BAIDU_SECRET_KEY
 */

import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { convertToWav } from './transcribe-audio.js'
import { sttEnv, STT_ENV } from './transcribe-env.js'
import { TranscribeError } from './transcribe-types.js'

const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token'
const ASR_URL = 'https://vop.baidu.com/server_api'
const TIMEOUT_MS = 60_000

let cachedToken: { value: string; expiresAt: number } | null = null

export function isBaiduSpeechConfigured(): boolean {
  return !!(sttEnv('baiduApiKey') && sttEnv('baiduSecretKey'))
}

async function getAccessToken(): Promise<string> {
  const apiKey = sttEnv('baiduApiKey')
  const secretKey = sttEnv('baiduSecretKey')
  if (!apiKey || !secretKey) {
    throw new TranscribeError(`${STT_ENV.baiduApiKey} / ${STT_ENV.baiduSecretKey} not set`, 'baidu')
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value
  }
  const url = new URL(TOKEN_URL)
  url.searchParams.set('grant_type', 'client_credentials')
  url.searchParams.set('client_id', apiKey)
  url.searchParams.set('client_secret', secretKey)
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) })
  const data = await res.json() as { access_token?: string; expires_in?: number; error_description?: string }
  if (!data.access_token) {
    throw new TranscribeError(data.error_description || 'failed to get Baidu access_token', 'baidu')
  }
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 2592000) - 300) * 1000,
  }
  return data.access_token
}

/** Reset token cache (tests). */
export function _resetBaiduTokenCache(): void {
  cachedToken = null
}

export async function transcribeWithBaidu(filePath: string, opts?: { language?: string }): Promise<string> {
  const wavPath = join(tmpdir(), `agim-baidu-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath, 'baidu')
    const pcmOrWav = await readFile(wavPath)
    const token = await getAccessToken()
    // 1537 = Mandarin input-method model; 1737 = English
    const lang = (opts?.language || 'zh').toLowerCase()
    const devPid = lang.startsWith('en') ? 1737 : 1537
    const body = {
      format: 'wav',
      rate: 16000,
      channel: 1,
      cuid: 'agim-cli',
      token,
      len: pcmOrWav.length,
      speech: pcmOrWav.toString('base64'),
      dev_pid: devPid,
    }
    const res = await fetch(ASR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await res.json() as {
      err_no?: number
      err_msg?: string
      result?: string[]
    }
    if (data.err_no !== 0) {
      throw new TranscribeError(data.err_msg || `Baidu err_no=${data.err_no}`, 'baidu')
    }
    const text = (data.result || []).join('').trim()
    if (!text) throw new TranscribeError('empty Baidu result', 'baidu')
    return text
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
