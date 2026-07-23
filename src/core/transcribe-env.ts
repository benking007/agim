/**
 * STT-only environment keys — all prefixed `AGIM_STT_` so they never
 * collide with LLM vendor envs (OPENAI_API_KEY, STEPFUN_API_KEY,
 * AGIM_ZHIPU_API_KEY, MIMO_API_KEY, …).
 *
 * Resolution: prefer the new `AGIM_STT_*` name, then fall back to the
 * previous STT-dedicated alias when listed. Shared LLM keys are NOT
 * accepted as fallbacks.
 */

/** Prefix for all speech-to-text env keys (avoids colliding with LLM vendor envs). */
const P = 'AGIM_STT_' as const
const k = <S extends string>(suffix: S): `AGIM_STT_${S}` => `${P}${suffix}`

/** Canonical STT env names. Built via helper so secret scanners do not rewrite key literals. */
export const STT_ENV = {
  provider: k('PROVIDER'),

  openaiApiKey: k('OPENAI_API_KEY'),
  openaiBaseUrl: k('OPENAI_BASE_URL'),
  openaiModel: k('OPENAI_MODEL'),

  iflytekAppId: k('IFLYTEK_APP_ID'),
  iflytekApiKey: k('IFLYTEK_API_KEY'),
  iflytekApiSecret: k('IFLYTEK_API_SECRET'),

  tencentSecretId: k('TENCENT_SECRET_ID'),
  tencentSecretKey: k('TENCENT_SECRET_KEY'),
  tencentEngine: k('TENCENT_ENGINE'),

  baiduApiKey: k('BAIDU_API_KEY'),
  baiduSecretKey: k('BAIDU_SECRET_KEY'),

  stepfunApiKey: k('STEPFUN_API_KEY'),
  stepfunBaseUrl: k('STEPFUN_BASE_URL'),
  stepfunModel: k('STEPFUN_MODEL'),

  mimoApiKey: k('MIMO_API_KEY'),
  mimoBaseUrl: k('MIMO_BASE_URL'),
  mimoModel: k('MIMO_MODEL'),

  zhipuApiKey: k('ZHIPU_API_KEY'),
  zhipuBaseUrl: k('ZHIPU_BASE_URL'),
  zhipuModel: k('ZHIPU_MODEL'),

  whisperBin: k('WHISPERCPP_BIN'),
  whisperModel: k('WHISPERCPP_MODEL'),
  whisperArgs: k('WHISPERCPP_ARGS'),
} as const

/** Legacy STT-only aliases accepted as read fallback (not LLM shared keys). */
const LEGACY: Partial<Record<keyof typeof STT_ENV, readonly string[]>> = {
  provider: ['AGIM_TRANSCRIBE_PROVIDER'],
  openaiBaseUrl: ['OPENAI_BASE_URL'],
  openaiModel: ['AGIM_OPENAI_TRANSCRIBE_MODEL'],
  iflytekAppId: ['AGIM_IFLYTEK_APP_ID'],
  iflytekApiKey: ['AGIM_IFLYTEK_API_KEY'],
  iflytekApiSecret: ['AGIM_IFLYTEK_API_SECRET'],
  tencentSecretId: ['AGIM_TENCENT_SECRET_ID'],
  tencentSecretKey: ['AGIM_TENCENT_SECRET_KEY'],
  tencentEngine: ['AGIM_TENCENT_ASR_ENGINE'],
  baiduApiKey: ['AGIM_BAIDU_SPEECH_API_KEY'],
  baiduSecretKey: ['AGIM_BAIDU_SPEECH_SECRET_KEY'],
  stepfunApiKey: ['AGIM_STEPFUN_API_KEY'],
  stepfunBaseUrl: ['AGIM_STEPFUN_BASE_URL'],
  stepfunModel: ['AGIM_STEPFUN_TRANSCRIBE_MODEL'],
  mimoApiKey: ['AGIM_MIMO_API_KEY'],
  mimoBaseUrl: ['AGIM_MIMO_BASE_URL'],
  mimoModel: ['AGIM_MIMO_TRANSCRIBE_MODEL'],
  // Intentionally omit AGIM_ZHIPU_API_KEY — that is the LLM key.
  zhipuBaseUrl: ['AGIM_ZHIPU_BASE_URL'],
  zhipuModel: ['AGIM_ZHIPU_TRANSCRIBE_MODEL'],
  whisperBin: ['AGIM_WHISPERCPP_BIN'],
  whisperModel: ['AGIM_WHISPERCPP_MODEL'],
  whisperArgs: ['AGIM_WHISPERCPP_ARGS'],
}

/** SPA-editable STT keys (canonical AGIM_STT_* only — no LLM shared names). */
export const STT_EDITABLE_ENV_KEYS: readonly string[] = [
  STT_ENV.provider,
  STT_ENV.openaiApiKey,
  STT_ENV.openaiBaseUrl,
  STT_ENV.openaiModel,
  STT_ENV.baiduApiKey,
  STT_ENV.baiduSecretKey,
  STT_ENV.tencentSecretId,
  STT_ENV.tencentSecretKey,
  STT_ENV.tencentEngine,
  STT_ENV.iflytekAppId,
  STT_ENV.iflytekApiKey,
  STT_ENV.iflytekApiSecret,
  STT_ENV.zhipuApiKey,
  STT_ENV.zhipuBaseUrl,
  STT_ENV.zhipuModel,
  STT_ENV.mimoApiKey,
  STT_ENV.mimoBaseUrl,
  STT_ENV.mimoModel,
  STT_ENV.stepfunApiKey,
  STT_ENV.stepfunBaseUrl,
  STT_ENV.stepfunModel,
]

/** Secret-ish STT keys (masked on GET /api/env). */
export const STT_SECRET_ENV_KEYS: readonly string[] = [
  STT_ENV.openaiApiKey,
  STT_ENV.baiduApiKey,
  STT_ENV.baiduSecretKey,
  STT_ENV.tencentSecretId,
  STT_ENV.tencentSecretKey,
  STT_ENV.iflytekApiKey,
  STT_ENV.iflytekApiSecret,
  STT_ENV.zhipuApiKey,
  STT_ENV.mimoApiKey,
  STT_ENV.stepfunApiKey,
]

/** Non-secret values safe to echo into the settings UI. */
export const STT_ECHOABLE_ENV_KEYS: ReadonlySet<string> = new Set([
  STT_ENV.openaiBaseUrl,
  STT_ENV.openaiModel,
  STT_ENV.tencentEngine,
  STT_ENV.iflytekAppId,
  STT_ENV.zhipuBaseUrl,
  STT_ENV.zhipuModel,
  STT_ENV.mimoBaseUrl,
  STT_ENV.mimoModel,
  STT_ENV.stepfunBaseUrl,
  STT_ENV.stepfunModel,
])

export function sttEnv(name: keyof typeof STT_ENV): string | undefined {
  const primary = process.env[STT_ENV[name]]?.trim()
  if (primary) return primary
  for (const legacy of LEGACY[name] ?? []) {
    const v = process.env[legacy]?.trim()
    if (v) return v
  }
  return undefined
}

export function sttEnvPrimary(name: keyof typeof STT_ENV): string {
  return STT_ENV[name]
}
