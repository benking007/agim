// transcribe — speech-to-text with provider abstraction.
//
// Providers:
//   - openai      — OpenAI Whisper API (OPENAI_API_KEY)
//   - whispercpp  — local whisper.cpp binary
//   - baidu       — 百度短语音识别
//   - tencent     — 腾讯云一句话识别
//   - iflytek     — 讯飞语音听写 (WebSocket IAT)
//
// Selection order (first hit wins):
//   1. AGIM_TRANSCRIBE_PROVIDER=<name>|none — explicit default
//   2. Auto: openai → baidu → tencent → iflytek → whispercpp
//   3. else → 'none'

import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { logger as rootLogger } from './logger.js'
import { convertToWav } from './transcribe-audio.js'
import { isBaiduSpeechConfigured, transcribeWithBaidu } from './transcribe-baidu.js'
import { isTencentSpeechConfigured, transcribeWithTencent } from './transcribe-tencent.js'
import { isIflytekSpeechConfigured, transcribeWithIflytek } from './transcribe-iflytek.js'
import {
  ALL_TRANSCRIBE_PROVIDERS,
  STT_UI_PROVIDER_ORDER,
  TranscribeError,
  type TranscribeOptions,
  type TranscribeProvider,
  type TranscribeResult,
} from './transcribe-types.js'

export {
  TranscribeError,
  ALL_TRANSCRIBE_PROVIDERS,
  STT_UI_PROVIDER_ORDER,
  type TranscribeOptions,
  type TranscribeProvider,
  type TranscribeResult,
}

const log = rootLogger.child({ component: 'transcribe' })

/** Non-secret keys we can safely echo back to the settings UI. */
const ECHOABLE_ENV_KEYS = new Set([
  'OPENAI_BASE_URL',
  'AGIM_OPENAI_TRANSCRIBE_MODEL',
  'AGIM_TENCENT_ASR_ENGINE',
  'AGIM_WHISPERCPP_BIN',
  'AGIM_WHISPERCPP_MODEL',
  'AGIM_WHISPERCPP_ARGS',
  'AGIM_IFLYTEK_APP_ID',
])

export interface TranscribeProviderInfo {
  id: Exclude<TranscribeProvider, 'none'>
  label: string
  /** Env keys the operator should fill (secrets + paths). */
  envKeys: string[]
  /** True when credentials / binary look present. */
  configured: boolean
  /** Local fallback shown first in the settings UI. */
  fallback?: boolean
  /** Current non-secret values from process.env (for path/model fields). */
  currentValues?: Record<string, string>
}

const PROVIDER_META: Record<
  Exclude<TranscribeProvider, 'none'>,
  Omit<TranscribeProviderInfo, 'configured' | 'currentValues'>
> = {
  whispercpp: {
    id: 'whispercpp',
    label: 'whisper.cpp（本地兜底）',
    envKeys: ['AGIM_WHISPERCPP_BIN', 'AGIM_WHISPERCPP_MODEL', 'AGIM_WHISPERCPP_ARGS'],
    fallback: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI Whisper',
    envKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AGIM_OPENAI_TRANSCRIBE_MODEL'],
  },
  baidu: {
    id: 'baidu',
    label: '百度短语音识别',
    envKeys: ['AGIM_BAIDU_SPEECH_API_KEY', 'AGIM_BAIDU_SPEECH_SECRET_KEY'],
  },
  tencent: {
    id: 'tencent',
    label: '腾讯云一句话识别',
    envKeys: ['AGIM_TENCENT_SECRET_ID', 'AGIM_TENCENT_SECRET_KEY', 'AGIM_TENCENT_ASR_ENGINE'],
  },
  iflytek: {
    id: 'iflytek',
    label: '讯飞语音听写',
    envKeys: ['AGIM_IFLYTEK_APP_ID', 'AGIM_IFLYTEK_API_KEY', 'AGIM_IFLYTEK_API_SECRET'],
  },
}

export function isProviderConfigured(provider: Exclude<TranscribeProvider, 'none'>): boolean {
  switch (provider) {
    case 'openai':
      return !!process.env.OPENAI_API_KEY
    case 'whispercpp':
      return !!(process.env.AGIM_WHISPERCPP_BIN && process.env.AGIM_WHISPERCPP_MODEL)
    case 'baidu':
      return isBaiduSpeechConfigured()
    case 'tencent':
      return isTencentSpeechConfigured()
    case 'iflytek':
      return isIflytekSpeechConfigured()
    default:
      return false
  }
}

export function listTranscribeProviders(): {
  providers: TranscribeProviderInfo[]
  active: TranscribeProvider
  explicit: string | null
} {
  const explicit = process.env.AGIM_TRANSCRIBE_PROVIDER?.trim() || null
  return {
    providers: STT_UI_PROVIDER_ORDER.map((id) => {
      const meta = PROVIDER_META[id]
      const currentValues: Record<string, string> = {}
      for (const key of meta.envKeys) {
        if (!ECHOABLE_ENV_KEYS.has(key)) continue
        const v = process.env[key]
        if (v) currentValues[key] = v
      }
      return {
        ...meta,
        configured: isProviderConfigured(id),
        currentValues: Object.keys(currentValues).length ? currentValues : undefined,
      }
    }),
    active: detectProvider(),
    explicit,
  }
}

/** Resolve which provider to use given current env. Pure / sync. */
export function detectProvider(): TranscribeProvider {
  const explicit = process.env.AGIM_TRANSCRIBE_PROVIDER?.toLowerCase()
  if (
    explicit === 'openai'
    || explicit === 'whispercpp'
    || explicit === 'baidu'
    || explicit === 'tencent'
    || explicit === 'iflytek'
    || explicit === 'none'
  ) {
    return explicit
  }
  for (const id of ALL_TRANSCRIBE_PROVIDERS) {
    if (isProviderConfigured(id)) return id
  }
  return 'none'
}

const TRANSCRIBE_TIMEOUT_MS = 120 * 1000

export async function transcribe(filePath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const provider = opts.provider ?? detectProvider()
  if (provider === 'none') {
    throw new TranscribeError(
      'no provider configured (set AGIM_TRANSCRIBE_PROVIDER + vendor keys, or OPENAI_API_KEY / AGIM_WHISPERCPP_BIN)',
      'none',
    )
  }
  const start = Date.now()
  let text: string
  switch (provider) {
    case 'openai':
      text = await transcribeWithOpenAI(filePath, opts)
      break
    case 'whispercpp':
      text = await transcribeWithWhisperCpp(filePath, opts)
      break
    case 'baidu':
      text = await transcribeWithBaidu(filePath, opts)
      break
    case 'tencent':
      text = await transcribeWithTencent(filePath, opts)
      break
    case 'iflytek':
      text = await transcribeWithIflytek(filePath, opts)
      break
    default:
      throw new TranscribeError(`unknown provider: ${provider as string}`, 'none')
  }
  const elapsedMs = Date.now() - start
  log.info({ event: 'transcribe.ok', provider, elapsedMs, chars: text.length, file: basename(filePath) })
  return { text, provider, elapsedMs }
}

async function transcribeWithOpenAI(filePath: string, opts: TranscribeOptions): Promise<string> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new TranscribeError('OPENAI_API_KEY not set', 'openai')
  const baseURL = process.env.OPENAI_BASE_URL?.replace(/\/$/, '') ?? 'https://api.openai.com/v1'
  const model = process.env.AGIM_OPENAI_TRANSCRIBE_MODEL ?? 'whisper-1'

  const fileBuf = await readFile(filePath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(fileBuf)]), basename(filePath))
  form.append('model', model)
  form.append('response_format', 'json')
  if (opts.language) form.append('language', opts.language)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: ctrl.signal,
    })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new TranscribeError(`timeout (${TRANSCRIBE_TIMEOUT_MS}ms)`, 'openai')
    }
    throw new TranscribeError(`fetch failed: ${(err as Error).message}`, 'openai')
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new TranscribeError(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`, 'openai')
  }
  const data = (await res.json()) as { text?: string }
  if (typeof data.text !== 'string') {
    throw new TranscribeError('response missing text field', 'openai')
  }
  return data.text.trim()
}

async function transcribeWithWhisperCpp(filePath: string, opts: TranscribeOptions): Promise<string> {
  const bin = process.env.AGIM_WHISPERCPP_BIN
  const model = process.env.AGIM_WHISPERCPP_MODEL
  if (!bin) throw new TranscribeError('AGIM_WHISPERCPP_BIN not set', 'whispercpp')
  if (!model) throw new TranscribeError('AGIM_WHISPERCPP_MODEL not set', 'whispercpp')

  const wavPath = join(tmpdir(), `agim-whisper-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath, 'whispercpp')

    const extraArgs = (process.env.AGIM_WHISPERCPP_ARGS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const args = ['-m', model, '-f', wavPath, '--no-prints', '--no-timestamps', ...extraArgs]
    if (opts.language) args.push('-l', opts.language)

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        settle(() => reject(new TranscribeError(`timeout (${TRANSCRIBE_TIMEOUT_MS}ms)`, 'whispercpp')))
      }, TRANSCRIBE_TIMEOUT_MS)
      child.stdout.on('data', (b: Buffer) => stdout.push(b))
      child.stderr.on('data', (b: Buffer) => stderr.push(b))
      child.on('error', (e) => {
        clearTimeout(timer)
        settle(() => reject(new TranscribeError(`spawn failed: ${e.message}`, 'whispercpp')))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          const errText = Buffer.concat(stderr).toString().slice(0, 400)
          settle(() => reject(new TranscribeError(`exit ${code}: ${errText}`, 'whispercpp')))
          return
        }
        const text = Buffer.concat(stdout).toString().trim()
        settle(() => resolve(text))
      })
    })
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
