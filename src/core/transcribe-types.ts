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

export const ALL_TRANSCRIBE_PROVIDERS: Exclude<TranscribeProvider, 'none'>[] = [
  'openai',
  'baidu',
  'tencent',
  'iflytek',
  'whispercpp',
]
