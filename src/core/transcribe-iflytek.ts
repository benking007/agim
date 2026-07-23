/**
 * iFlytek (讯飞) streaming IAT — short dictation via WebSocket.
 * Docs: https://www.xfyun.cn/doc/asr/voicedictation/API.html
 *
 * Env (STT-prefixed):
 *   AGIM_STT_IFLYTEK_APP_ID
 *   AGIM_STT_IFLYTEK_API_KEY
 *   AGIM_STT_IFLYTEK_API_SECRET
 */

import { createHmac, randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertToWav } from './transcribe-audio.js'
import { sttEnv, STT_ENV } from './transcribe-env.js'
import { TranscribeError } from './transcribe-types.js'

const HOST = 'iat-api.xfyun.cn'
const PATH = '/v2/iat'
const TIMEOUT_MS = 60_000
const FRAME_SIZE = 1280 // 40ms @ 16kHz 16bit mono

export function isIflytekSpeechConfigured(): boolean {
  return !!(sttEnv('iflytekAppId') && sttEnv('iflytekApiKey') && sttEnv('iflytekApiSecret'))
}

function buildAuthUrl(apiKey: string, apiSecret: string): string {
  const date = new Date().toUTCString()
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`
  const signature = createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64')
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  const authorization = Buffer.from(authorizationOrigin).toString('base64')
  const qs = new URLSearchParams({
    authorization,
    date,
    host: HOST,
  })
  return `wss://${HOST}${PATH}?${qs.toString()}`
}

export async function transcribeWithIflytek(filePath: string, opts?: { language?: string }): Promise<string> {
  const appId = sttEnv('iflytekAppId')
  const apiKey = sttEnv('iflytekApiKey')
  const apiSecret = sttEnv('iflytekApiSecret')
  if (!appId || !apiKey || !apiSecret) {
    throw new TranscribeError(
      `${STT_ENV.iflytekAppId} / ${STT_ENV.iflytekApiKey} / ${STT_ENV.iflytekApiSecret} not set`,
      'iflytek',
    )
  }

  const wavPath = join(tmpdir(), `agim-iflytek-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath, 'iflytek')
    // Skip 44-byte WAV header → raw PCM for IAT
    const wav = await readFile(wavPath)
    const pcm = wav.length > 44 ? wav.subarray(44) : wav
    const lang = (opts?.language || 'zh').toLowerCase()
    const language = lang.startsWith('en') ? 'en_us' : 'zh_cn'

    const url = buildAuthUrl(apiKey, apiSecret)
    const text = await new Promise<string>((resolve, reject) => {
      let settled = false
      const parts: string[] = []
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* ignore */ }
        settle(() => reject(new TranscribeError(`timeout (${TIMEOUT_MS}ms)`, 'iflytek')))
      }, TIMEOUT_MS)

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      ws.onerror = () => {
        settle(() => reject(new TranscribeError('WebSocket error', 'iflytek')))
      }
      ws.onclose = () => {
        if (!settled) {
          const joined = parts.join('').trim()
          if (joined) settle(() => resolve(joined))
          else settle(() => reject(new TranscribeError('connection closed before result', 'iflytek')))
        }
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            code?: number
            message?: string
            data?: {
              status?: number
              result?: { ws?: Array<{ cw?: Array<{ w?: string }> }> }
            }
          }
          if (msg.code !== 0) {
            settle(() => reject(new TranscribeError(msg.message || `code=${msg.code}`, 'iflytek')))
            return
          }
          const words = msg.data?.result?.ws ?? []
          for (const w of words) {
            for (const c of w.cw ?? []) {
              if (c.w) parts.push(c.w)
            }
          }
          if (msg.data?.status === 2) {
            const joined = parts.join('').trim()
            try { ws.close() } catch { /* ignore */ }
            if (!joined) settle(() => reject(new TranscribeError('empty iFlytek result', 'iflytek')))
            else settle(() => resolve(joined))
          }
        } catch (err) {
          settle(() => reject(new TranscribeError(
            err instanceof Error ? err.message : 'parse error',
            'iflytek',
          )))
        }
      }

      ws.onopen = () => {
        // Send PCM in frames
        let offset = 0
        let first = true
        const sendNext = (): void => {
          if (settled) return
          if (offset >= pcm.length) {
            // final empty frame
            ws.send(JSON.stringify({
              data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
            }))
            return
          }
          const end = Math.min(offset + FRAME_SIZE, pcm.length)
          const chunk = pcm.subarray(offset, end)
          offset = end
          const status = first ? 0 : (offset >= pcm.length ? 2 : 1)
          first = false
          const frame: Record<string, unknown> = {
            data: {
              status,
              format: 'audio/L16;rate=16000',
              encoding: 'raw',
              audio: chunk.toString('base64'),
            },
          }
          if (status === 0) {
            frame.common = { app_id: appId }
            frame.business = {
              language,
              domain: 'iat',
              accent: 'mandarin',
              vad_eos: 2000,
            }
          }
          ws.send(JSON.stringify(frame))
          if (status !== 2) setTimeout(sendNext, 40)
        }
        sendNext()
      }
    })
    return text
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
