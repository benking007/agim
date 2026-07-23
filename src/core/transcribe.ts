// transcribe — speech-to-text with provider abstraction.
//
// Providers (cloud credentials: AGIM_STT_* only — never LLM shared keys):
//   - openai      — OpenAI Whisper API
//   - whispercpp  — built-in open-source local STT (whisper.cpp)
//   - baidu       — 百度短语音识别
//   - tencent     — 腾讯云一句话识别
//   - iflytek     — 讯飞语音听写 (WebSocket IAT)
//   - glm         — 智谱 GLM-ASR
//   - mimo        — 小米 MiMo-V2.5-ASR
//   - stepfun     — 阶跃 StepAudio 2.5 ASR
//
// Selection order (first hit wins):
//   1. AGIM_STT_PROVIDER=<name>|none — explicit default
//   2. Auto (Chinese quality / stability / cost):
//        iflytek → tencent → baidu → stepfun → mimo → glm → openai → whispercpp
//   3. else → 'none'
//
// whisper.cpp is the built-in offline engine: resolves ~/.agim/whisper/,
// PATH, and AGIM_STT_WHISPERCPP_* / AGIM_WHISPERCPP_*; model auto-downloads.

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
import { isGlmSpeechConfigured, transcribeWithGlm } from './transcribe-glm.js'
import { isMimoSpeechConfigured, transcribeWithMimo } from './transcribe-mimo.js'
import { isStepfunSpeechConfigured, transcribeWithStepfun } from './transcribe-stepfun.js'
import {
  STT_ECHOABLE_ENV_KEYS,
  STT_ENV,
  sttEnv,
} from './transcribe-env.js'
import {
  getWhisperModelStatus,
  isWhisperCppReady,
  resolveWhisperCppForTranscribe,
  whisperCppInstallHintEn,
  type WhisperModelStatus,
} from './transcribe-whispercpp-resolve.js'
import {
  ALL_TRANSCRIBE_PROVIDERS,
  TranscribeError,
  type TranscribeOptions,
  type TranscribeProvider,
  type TranscribeResult,
} from './transcribe-types.js'

export {
  TranscribeError,
  ALL_TRANSCRIBE_PROVIDERS,
  type TranscribeOptions,
  type TranscribeProvider,
  type TranscribeResult,
}

const log = rootLogger.child({ component: 'transcribe' })

export interface TranscribeProviderInfo {
  id: Exclude<TranscribeProvider, 'none'>
  label: string
  /** Env keys the operator should fill (secrets + paths). */
  envKeys: string[]
  /** True when credentials / binary look present. */
  configured: boolean
  /** Local offline fallback (whisper.cpp). */
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
    label: 'whisper.cpp（内置本地）',
    // Paths are host-managed; defaults live under ~/.agim/whisper/.
    envKeys: [],
    fallback: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI Whisper',
    envKeys: [STT_ENV.openaiApiKey, STT_ENV.openaiBaseUrl, STT_ENV.openaiModel],
  },
  baidu: {
    id: 'baidu',
    label: '百度短语音识别',
    envKeys: [STT_ENV.baiduApiKey, STT_ENV.baiduSecretKey],
  },
  tencent: {
    id: 'tencent',
    label: '腾讯云一句话识别',
    envKeys: [STT_ENV.tencentSecretId, STT_ENV.tencentSecretKey, STT_ENV.tencentEngine],
  },
  iflytek: {
    id: 'iflytek',
    label: '讯飞语音听写',
    envKeys: [STT_ENV.iflytekAppId, STT_ENV.iflytekApiKey, STT_ENV.iflytekApiSecret],
  },
  glm: {
    id: 'glm',
    label: '智谱 GLM-ASR',
    envKeys: [STT_ENV.zhipuApiKey, STT_ENV.zhipuBaseUrl, STT_ENV.zhipuModel],
  },
  mimo: {
    id: 'mimo',
    label: '小米 MiMo-ASR',
    envKeys: [STT_ENV.mimoApiKey, STT_ENV.mimoBaseUrl, STT_ENV.mimoModel],
  },
  stepfun: {
    id: 'stepfun',
    label: '阶跃 StepAudio-ASR',
    envKeys: [STT_ENV.stepfunApiKey, STT_ENV.stepfunBaseUrl, STT_ENV.stepfunModel],
  },
}

export function isProviderConfigured(provider: Exclude<TranscribeProvider, 'none'>): boolean {
  switch (provider) {
    case 'openai':
      return !!sttEnv('openaiApiKey')
    case 'whispercpp':
      return isWhisperCppReady()
    case 'baidu':
      return isBaiduSpeechConfigured()
    case 'tencent':
      return isTencentSpeechConfigured()
    case 'iflytek':
      return isIflytekSpeechConfigured()
    case 'glm':
      return isGlmSpeechConfigured()
    case 'mimo':
      return isMimoSpeechConfigured()
    case 'stepfun':
      return isStepfunSpeechConfigured()
    default:
      return false
  }
}

/** Settings list order: currently active → other configured → rest, each by auto priority. */
export function sortProvidersForUi(
  providers: TranscribeProviderInfo[],
  active: TranscribeProvider,
): TranscribeProviderInfo[] {
  const priority = new Map(ALL_TRANSCRIBE_PROVIDERS.map((id, i) => [id, i]))
  return [...providers].sort((a, b) => {
    const aActive = a.id === active ? 0 : 1
    const bActive = b.id === active ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    const aCfg = a.configured ? 0 : 1
    const bCfg = b.configured ? 0 : 1
    if (aCfg !== bCfg) return aCfg - bCfg
    return (priority.get(a.id) ?? 99) - (priority.get(b.id) ?? 99)
  })
}

export function listTranscribeProviders(): {
  providers: TranscribeProviderInfo[]
  active: TranscribeProvider
  explicit: string | null
  whisperModel: WhisperModelStatus
} {
  const explicit = sttEnv('provider') || null
  const active = detectProvider()
  const providers = ALL_TRANSCRIBE_PROVIDERS.map((id) => {
    const meta = PROVIDER_META[id]
    const currentValues: Record<string, string> = {}
    for (const key of meta.envKeys) {
      if (!STT_ECHOABLE_ENV_KEYS.has(key)) continue
      const v = process.env[key]?.trim()
      if (v) currentValues[key] = v
    }
    return {
      ...meta,
      configured: isProviderConfigured(id),
      currentValues: Object.keys(currentValues).length ? currentValues : undefined,
    }
  })
  return {
    providers: sortProvidersForUi(providers, active),
    active,
    explicit,
    whisperModel: getWhisperModelStatus(),
  }
}

/** Resolve which provider to use given current env. Pure / sync. */
export function detectProvider(): TranscribeProvider {
  const explicit = sttEnv('provider')?.toLowerCase()
  if (explicit === 'none') return 'none'
  // whisper.cpp is the built-in local engine — honor an explicit pin even
  // before the model file is downloaded (resolved at run time).
  if (explicit === 'whispercpp') return 'whispercpp'
  if (isExplicitProviderName(explicit) && explicit !== 'none' && isProviderConfigured(explicit)) {
    return explicit
  }
  for (const id of ALL_TRANSCRIBE_PROVIDERS) {
    if (isProviderConfigured(id)) return id
  }
  return 'none'
}

const TRANSCRIBE_TIMEOUT_MS = 120 * 1000

/** Operator-facing hint when no STT vendor is configured. */
export const STT_NOT_CONFIGURED_HINT =
  'no STT provider configured — open Web /settings/stt and set AGIM_STT_* vendor keys (or whisper.cpp)'

/** Chinese hint for IM voice placeholders. */
export const STT_NOT_CONFIGURED_HINT_ZH =
  '未配置语音转写（请在 Web /settings/stt 填写 AGIM_STT_* 厂商密钥）'

function isExplicitProviderName(value: string | undefined): value is Exclude<TranscribeProvider, 'none'> | 'none' {
  return (
    value === 'openai'
    || value === 'whispercpp'
    || value === 'baidu'
    || value === 'tencent'
    || value === 'iflytek'
    || value === 'glm'
    || value === 'mimo'
    || value === 'stepfun'
    || value === 'none'
  )
}

/** Configured providers in Auto priority order (for failover). */
export function configuredProvidersInAutoOrder(): Exclude<TranscribeProvider, 'none'>[] {
  return ALL_TRANSCRIBE_PROVIDERS.filter((id) => isProviderConfigured(id))
}

async function transcribeOnce(
  provider: Exclude<TranscribeProvider, 'none'>,
  filePath: string,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
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
    case 'glm':
      text = await transcribeWithGlm(filePath, opts)
      break
    case 'mimo':
      text = await transcribeWithMimo(filePath, opts)
      break
    case 'stepfun':
      text = await transcribeWithStepfun(filePath, opts)
      break
    default:
      throw new TranscribeError(`unknown provider: ${provider as string}`, 'none')
  }
  const elapsedMs = Date.now() - start
  log.info({ event: 'transcribe.ok', provider, elapsedMs, chars: text.length, file: basename(filePath) })
  return { text, provider, elapsedMs }
}

function missingProviderHint(provider: Exclude<TranscribeProvider, 'none'>): string {
  if (provider === 'whispercpp') return whisperCppInstallHintEn()
  const keys = PROVIDER_META[provider].envKeys.filter((k) => k.includes('KEY') || k.includes('SECRET') || k.includes('APP_ID'))
  const keyHint = keys.length ? keys.join(' / ') : 'AGIM_STT_*'
  return (
    `${provider} STT is not configured (need ${keyHint}) — open Web /settings/stt`
  )
}

/**
 * Run STT. Explicit `opts.provider` or `AGIM_STT_PROVIDER` pins one vendor
 * (no failover). whisper.cpp is the built-in local engine — a pin always
 * attempts local resolve (PATH / ~/.agim/whisper / env), never silently
 * falls through to Auto. Auto mode fails over across configured vendors.
 */
export async function transcribe(filePath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const explicitEnv = sttEnv('provider')?.toLowerCase()
  const envPinned = isExplicitProviderName(explicitEnv) ? explicitEnv : undefined

  if (opts.provider === 'none' || envPinned === 'none') {
    throw new TranscribeError(STT_NOT_CONFIGURED_HINT, 'none')
  }

  // Caller-requested provider always wins (tests / admin tools).
  if (opts.provider) {
    if (opts.provider !== 'whispercpp' && !isProviderConfigured(opts.provider)) {
      throw new TranscribeError(missingProviderHint(opts.provider), opts.provider)
    }
    return transcribeOnce(opts.provider, filePath, opts)
  }

  // Env pin: whisper.cpp always attempted (built-in); cloud pins need keys.
  if (envPinned === 'whispercpp') {
    return transcribeOnce('whispercpp', filePath, opts)
  }
  if (envPinned && isProviderConfigured(envPinned)) {
    return transcribeOnce(envPinned, filePath, opts)
  }

  const chain = configuredProvidersInAutoOrder()
  if (chain.length === 0) {
    throw new TranscribeError(STT_NOT_CONFIGURED_HINT, 'none')
  }

  let lastErr: unknown
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i]!
    try {
      return await transcribeOnce(provider, filePath, opts)
    } catch (err) {
      lastErr = err
      const next = chain[i + 1]
      log.warn({
        event: 'transcribe.failover',
        provider,
        next: next ?? null,
        error: err instanceof Error ? err.message : String(err),
        file: basename(filePath),
      })
      if (!next) break
    }
  }
  if (lastErr instanceof TranscribeError) throw lastErr
  throw new TranscribeError(
    lastErr instanceof Error ? lastErr.message : String(lastErr),
    chain[chain.length - 1] ?? 'none',
  )
}

async function transcribeWithOpenAI(filePath: string, opts: TranscribeOptions): Promise<string> {
  const key = sttEnv('openaiApiKey')
  if (!key) throw new TranscribeError(`${STT_ENV.openaiApiKey} not set`, 'openai')
  const baseURL = (sttEnv('openaiBaseUrl') || 'https://api.openai.com/v1').replace(/\/$/, '')
  const model = sttEnv('openaiModel') || 'whisper-1'

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
  let bin: string
  let model: string
  try {
    ;({ bin, model } = await resolveWhisperCppForTranscribe())
  } catch (err) {
    throw new TranscribeError(
      err instanceof Error ? err.message : whisperCppInstallHintEn(),
      'whispercpp',
    )
  }

  const wavPath = join(tmpdir(), `agim-whisper-${randomBytes(6).toString('hex')}.wav`)
  try {
    await convertToWav(filePath, wavPath, 'whispercpp')

    const extraArgs = (sttEnv('whisperArgs') ?? process.env.AGIM_WHISPERCPP_ARGS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
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
