export type TranscribeProvider =
  | 'openai'
  | 'whispercpp'
  | 'baidu'
  | 'tencent'
  | 'iflytek'
  | 'none'

export interface TranscribeResult {
  text: string
  provider: Exclude<TranscribeProvider, 'none'>
  elapsedMs: number
}

export interface TranscribeOptions {
  language?: string
  provider?: TranscribeProvider
}

export class TranscribeError extends Error {
  constructor(public reason: string, public provider: TranscribeProvider) {
    super(`transcribe failed (${provider}): ${reason}`)
    this.name = 'TranscribeError'
  }
}

/** Auto-detect priority (first configured wins). whisper.cpp is last = fallback. */
export const ALL_TRANSCRIBE_PROVIDERS: Exclude<TranscribeProvider, 'none'>[] = [
  'openai',
  'baidu',
  'tencent',
  'iflytek',
  'whispercpp',
]

/** Settings UI order — whisper.cpp pinned first as the local fallback. */
export const STT_UI_PROVIDER_ORDER: Exclude<TranscribeProvider, 'none'>[] = [
  'whispercpp',
  'openai',
  'baidu',
  'tencent',
  'iflytek',
]
