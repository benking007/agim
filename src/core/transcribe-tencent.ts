/**
 * Tencent Cloud SentenceRecognition (≤60s).
 * Docs: https://cloud.tencent.com/document/api/1093/35646
 *
 * Env (STT-prefixed):
 *   AGIM_STT_TENCENT_SECRET_ID
 *   AGIM_STT_TENCENT_SECRET_KEY
 *   AGIM_STT_TENCENT_ENGINE (optional, default 16k_zh)
 */

import { createHash, createHmac } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { convertToWav } from './transcribe-audio.js'
import { sttEnv, STT_ENV } from './transcribe-env.js'
import { TranscribeError } from './transcribe-types.js'

const HOST = 'asr.tencentcloudapi.com'
const SERVICE = 'asr'
const ACTION = 'SentenceRecognition'
const VERSION = '2019-06-14'
const TIMEOUT_MS = 60_000

export function isTencentSpeechConfigured(): boolean {
  return !!(sttEnv('tencentSecretId') && sttEnv('tencentSecretKey'))
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function tc3Authorization(secretId: string, secretKey: string, payload: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const contentType = 'application/json; charset=utf-8'
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\n`
  const signedHeaders = 'content-type;host'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payload),
  ].join('\n')
  const credentialScope = `${date}/${SERVICE}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const secretDate = hmacSha256(`TC3${secretKey}`, date)
  const secretService = hmacSha256(secretDate, SERVICE)
  const secretSigning = hmacSha256(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

export async function transcribeWithTencent(filePath: string, opts?: { language?: string }): Promise<string> {
  const secretId = sttEnv('tencentSecretId')
  const secretKey = sttEnv('tencentSecretKey')
  if (!secretId || !secretKey) {
    throw new TranscribeError(`${STT_ENV.tencentSecretId} / ${STT_ENV.tencentSecretKey} not set`, 'tencent')
  }
  const lang = (opts?.language || 'zh').toLowerCase()
  const engine = sttEnv('tencentEngine')
    || (lang.startsWith('en') ? '16k_en' : '16k_zh')

  const wavPath = join(tmpdir(), `agim-tencent-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath, 'tencent')
    const buf = await readFile(wavPath)
    const payloadObj = {
      EngSerViceType: engine,
      SourceType: 1,
      VoiceFormat: 'wav',
      Data: buf.toString('base64'),
      DataLen: buf.length,
    }
    const payload = JSON.stringify(payloadObj)
    const timestamp = Math.floor(Date.now() / 1000)
    const authorization = tc3Authorization(secretId, secretKey, payload, timestamp)
    const res = await fetch(`https://${HOST}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: HOST,
        'X-TC-Action': ACTION,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': String(timestamp),
        Authorization: authorization,
      },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await res.json() as {
      Response?: {
        Result?: string
        Error?: { Code?: string; Message?: string }
      }
    }
    if (data.Response?.Error) {
      throw new TranscribeError(
        `${data.Response.Error.Code || 'Error'}: ${data.Response.Error.Message || 'unknown'}`,
        'tencent',
      )
    }
    const text = (data.Response?.Result || '').trim()
    if (!text) throw new TranscribeError('empty Tencent result', 'tencent')
    return text
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
