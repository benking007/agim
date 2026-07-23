export type TranscribeProvider =
  | 'openai'
  | 'whispercpp'
  | 'baidu'
  | 'tencent'
  | 'iflytek'
  | 'glm'
  | 'mimo'
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

/**
 * Auto-detect priority (first configured wins).
 *
 * Tuned for Chinese short-command dictation by:
 *   1) Chinese ASR quality  2) cloud stability  3) free-tier / cost
 * Any configured cloud provider beats local whisper.cpp (fallback).
 *
 * Settings UI cards / select options reuse this order within each group:
 *   active → other configured → unconfigured.
 */
export const ALL_TRANSCRIBE_PROVIDERS: Exclude<TranscribeProvider, 'none'>[] = [
  'iflytek',    // strongest Chinese oral / dictation
  'tencent',    // stable cloud + monthly free quota
  'baidu',      // mature Mandarin short ASR
  'mimo',       // MiMo-V2.5-ASR — Chinese + dialects, noise-robust
  'glm',        // Zhipu GLM-ASR — solid Chinese, strong cost
  'openai',     // multilingual; weaker Chinese CER; paid
  'whispercpp', // local offline fallback only
]
