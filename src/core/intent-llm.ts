// LLM-backed intent fallback (P2-H).
//
// When the rule-based classifier produces a low-confidence result we
// ask a configured "judge agent" — itself one of the registered agents
// — to pick the best agent. Opt-in via env (IM_HUB_LLM_JUDGE_AGENT)
// or programmatic configureLLMJudge() so we never silently spend
// tokens by default.
//
// Caching: identical prompt+candidate-list pairs are memoized within a
// 10-minute window so repeated chat-room banter doesn't burn budget.

import { createHash } from 'node:crypto'
import type { AgentAdapter } from './types.js'
import { logger as rootLogger } from './logger.js'
import { getProvider, tryIntrospect } from './llm/index.js'

const log = rootLogger.child({ component: 'intent-llm' })

const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX_ENTRIES = 1000  // LRU upper bound prevents unbounded growth
const RESPONSE_TIMEOUT_MS = 5_000

interface CachedDecision {
  agent: string
  reason: string
  ts: number
}

/**
 * LRU cache: insertion-order Map; on access we delete + re-set to bump
 * the entry to the end. When size exceeds max we evict the head (the
 * oldest unused entry).
 */
class LRUCache<K, V extends { ts: number }> {
  private store = new Map<K, V>()
  constructor(private readonly maxSize: number, private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const v = this.store.get(key)
    if (!v) return undefined
    if (Date.now() - v.ts > this.ttlMs) {
      this.store.delete(key)
      return undefined
    }
    // Touch — move to end of insertion order
    this.store.delete(key)
    this.store.set(key, v)
    return v
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key)
    this.store.set(key, value)
    // Evict from the head until under cap
    while (this.store.size > this.maxSize) {
      const first = this.store.keys().next().value as K | undefined
      if (first === undefined) break
      this.store.delete(first)
    }
  }

  clear(): void { this.store.clear() }
  get size(): number { return this.store.size }
}

const cache = new LRUCache<string, CachedDecision>(CACHE_MAX_ENTRIES, CACHE_TTL_MS)

export interface LLMJudgeConfig {
  /** Agent name used as the judge. Must already be registered. */
  agentName: string
  /** Score threshold below which the LLM is consulted (default 1.0). */
  threshold?: number
  /** Override the default 5s response timeout. */
  timeoutMs?: number
}

let config: LLMJudgeConfig | null = null

export function configureLLMJudge(cfg: LLMJudgeConfig | null): void {
  config = cfg
  cache.clear()
}

/** Read the judge configuration. Used by classifyIntent to know whether
 *  to attempt a fallback at all. */
export function getLLMJudge(): LLMJudgeConfig | null {
  return config
}

/**
 * True when intent fallback can run — either via the legacy CLI judge
 * (`IM_HUB_LLM_JUDGE_AGENT` env / configureLLMJudge) OR via a native
 * 'cheap' LLM backend from D+ Stage 1. Router uses this to gate the
 * fallback path; previously it could only gate on `getLLMJudge()`,
 * which forced operators to set IM_HUB_LLM_JUDGE_AGENT even when they
 * only had a native backend wired.
 */
export function hasIntentFallback(): boolean {
  if (config !== null) return true
  return getProvider('cheap') !== null
}

/** Probe env on first import so common deployments get auto-config. */
function autoFromEnv(): void {
  const name = process.env.IM_HUB_LLM_JUDGE_AGENT
  if (name && !config) {
    const threshold = parseFloat(process.env.IM_HUB_LLM_JUDGE_THRESHOLD || '1.0')
    config = {
      agentName: name,
      threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 1.0,
    }
  }
}
autoFromEnv()

/** Hard cap on the prompt portion of the LRU key. Past this length the
 *  key collapses, which is fine for a memo cache (occasional re-call is
 *  cheap and doesn't affect correctness — the LLM judge runs again). It
 *  matters because the key was previously the full prompt concatenated
 *  with `|`-joined candidates, so a 100KB prompt + many candidates blew
 *  the LRU's per-entry memory cost. */
const MAX_KEY_TEXT_LEN = 256

function makeKey(text: string, candidates: string[]): string {
  // Hash the candidate list so the key length is bounded regardless of
  // how many ACP agents are registered. SHA-256/16-hex (64 bits) gives
  // 1-in-2^64 collision probability across the LRU window — irrelevant.
  const candHash = createHash('sha256')
    .update(candidates.slice().sort().join('|'))
    .digest('hex').slice(0, 16)
  const textKey = text.length > MAX_KEY_TEXT_LEN ? text.slice(0, MAX_KEY_TEXT_LEN) : text
  return `${candHash}||${textKey}`
}

function buildPrompt(text: string, candidates: string[]): string {
  return [
    'You are a router that picks the most appropriate agent for a user request.',
    'Reply with EXACTLY one agent name from the list — no explanation, no punctuation.',
    '',
    'Candidates:',
    ...candidates.map((c) => `  - ${c}`),
    '',
    `User request: ${text}`,
    '',
    'Best agent:',
  ].join('\n')
}

/**
 * Ask the judge agent which candidate to use. Returns null on any
 * failure path (timeout, judge unavailable, malformed response) so
 * the caller can keep its rule-based decision.
 */
export async function classifyWithLLM(
  text: string,
  candidates: string[],
  resolveAgent: (name: string) => AgentAdapter | undefined,
): Promise<{ agent: string; reason: string } | null> {
  // Enter as long as some fallback (legacy CLI judge OR native backend)
  // is available. Pre-D+ behaviour required `config != null`; we now
  // also accept a native-only setup.
  const nativeProvider = getProvider('cheap')
  if (!config && !nativeProvider) return null
  if (candidates.length === 0) return null

  const key = makeKey(text, candidates)
  const cached = cache.get(key)
  if (cached) {
    return { agent: cached.agent, reason: `${cached.reason} (cached)` }
  }

  const timeoutMs = config?.timeoutMs ?? RESPONSE_TIMEOUT_MS
  const prompt = buildPrompt(text, candidates)
  let raw = ''
  let viaNative = false

  // D+ Stage 1: prefer the 'cheap' native LLM backend. Fast (~200ms),
  // dollar-cheap, no CLI spawn. Falls through to the configured CLI
  // judge on no-backend OR failure so historical behaviour is intact.
  if (nativeProvider) {
    const nativeResult = await tryIntrospect({
      role: 'cheap',
      prompt,
      timeoutMs,
      temperature: 0,
    })
    if (nativeResult && nativeResult.text.trim().length > 0) {
      raw = nativeResult.text
      viaNative = true
    }
  }

  if (!viaNative) {
    if (!config) {
      log.warn({ event: 'intent-llm.native_failed_no_cli_fallback' },
        'native LLM judge failed and no CLI judge configured — skipping fallback')
      return null
    }
    const judge = resolveAgent(config.agentName)
    if (!judge) {
      log.warn({ judge: config.agentName }, 'LLM judge agent not registered')
      return null
    }
    try {
      let acc = ''
      const generator = judge.sendPrompt(`llm-judge`, prompt, [])
      const collect = (async () => {
        for await (const chunk of generator) {
          acc += chunk
          if (acc.length > 4096) break  // guard runaway output
        }
      })()
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('LLM judge timed out')), timeoutMs))

      await Promise.race([collect, timeout])
      raw = acc
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) },
        'LLM judge call failed')
      return null
    }
  }

  // Parse: take the first line, lowercase, strip punctuation, match
  // against candidates case-insensitively.
  const firstLine = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
  const cleaned = firstLine.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const match = candidates.find((c) => c.toLowerCase() === cleaned)
    ?? candidates.find((c) => cleaned.includes(c.toLowerCase()))

  if (!match) {
    log.warn({ raw: firstLine, candidates, viaNative }, 'LLM judge produced unrecognized output')
    return null
  }

  const decision = {
    agent: match,
    reason: viaNative ? `LLM judge (native) picked ${match}` : `LLM judge picked ${match}`,
  }
  cache.set(key, { ...decision, ts: Date.now() })
  return decision
}

/** Test-only: clear cache so memoization doesn't leak between cases. */
export function _clearLLMCache(): void {
  cache.clear()
}

/** Test/diagnostic: current cache size. */
export function _cacheSize(): number { return cache.size }
