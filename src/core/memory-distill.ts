// memory-distill — extracts long-term-worthy facts from a (user msg, agent
// reply) pair and writes them to memory.db. Runs asynchronously after the
// reply is delivered so the user never waits on distillation.
//
// Design choices (per the 2026-05-17 memory discussion):
//
//   * Use the SAME agent that just produced the reply. agim is model-agnostic
//     — assuming claude / haiku is always available would lock out operators
//     who only have codex / opencode. Cost is the user's already-
//     budgeted agent; quality matches their setup.
//
//   * Single shot, JSON-out. No tool loop, no chat — extraction is a pure
//     function. Keeps it cheap and predictable.
//
//   * Fire-and-forget. router.ts calls scheduleDistillation() right after
//     sink.deliver() and moves on. Errors are logged + dropped — they never
//     surface to the user.
//
//   * Confidence-based admission. Default new facts get confidence 0.6.
//     Future consolidation can promote frequently-confirmed facts to 0.9+
//     and demote unused ones; the v1.5 first cut just stores them.
//
//   * Dedup at write time (TODO: v1.6) — for now we just append. If
//     extraction surfaces "user lives in 杭州" three times in three turns,
//     we'll have three rows. Consolidation cron will dedupe.

import type { AgentAdapter } from './types.js'
import { logger as rootLogger } from './logger.js'
import { saveFact, userKey, type FactCategory } from './memory.js'
import { isMemoryEnabled } from './persona.js'
import { logInvocation } from './audit-log.js'
import { tryIntrospect } from './llm/index.js'

const log = rootLogger.child({ component: 'memory-distill' })

export interface DistillationInput {
  /** The IM platform (telegram / wechat / ...). */
  platform: string
  /** The IM user id (the human). Used as the memory partition key. */
  userId: string
  /** The user's prompt that triggered the agent. */
  userMessage: string
  /** The agent's reply text. */
  agentReply: string
  /** The agent that produced the reply. Used for the extraction call. */
  agent: AgentAdapter
  /** Optional: tracing id linking the extraction back to its source turn. */
  traceId?: string
  /** Optional: only run distillation when the reply or message reaches a
   *  minimum length. Skips trivial exchanges like "ok" / "thanks". */
  minLen?: number
}

const DEFAULT_MIN_LEN = 20

// Prompt sent to the agent for fact extraction. Returns JSON; we parse
// defensively (the LLM occasionally wraps in markdown fences).
function buildExtractionPrompt(userMessage: string, agentReply: string): string {
  return [
    '你是一个事实抽取器。从下面这一轮对话中提取最多 5 条**值得长期记住的事实**，',
    '输出严格的 JSON，结构如下，**不要任何额外文字 / markdown / 解释**：',
    '',
    '```json',
    '{',
    '  "facts": [',
    '    {',
    '      "what": "用户偏好早 8 点喝咖啡",  // 必填，1 句话，主语写 user/我/...都行',
    '      "category": "preference",         // fact|preference|goal|history|profile',
    '      "confidence": 0.8,                // 0-1，根据语境强弱',
    '      "who": "user",                     // 可选，事实涉及的主体',
    '      "when_text": "",                  // 可选',
    '      "where_label": "",                // 可选',
    '      "why": ""                          // 可选',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '严格执行：',
    '- **跳过寒暄 / 测试消息 / 临时性信息**（如"在不在"、"明天再说"）',
    '- 不要总结整轮对话；只挑可在未来对话里**复用**的事实',
    '- 用户没说的事**不要编造**（confidence 必须基于实际证据）',
    '- 如果这轮没有值得记的事实，**返回 `{"facts": []}`**',
    '- 输出**纯 JSON，不要 markdown 围栏**',
    '',
    '## 用户消息',
    userMessage.slice(0, 4000),
    '',
    '## Agent 回复',
    agentReply.slice(0, 4000),
  ].join('\n')
}

interface ExtractedFact {
  what: unknown
  category?: unknown
  confidence?: unknown
  who?: unknown
  when_text?: unknown
  where_label?: unknown
  why?: unknown
}

function tryParseFactsJson(raw: string): ExtractedFact[] {
  // Strip optional ```json fences and leading/trailing prose.
  let s = raw.trim()
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) s = fenceMatch[1].trim()
  // Trim everything before first `{` and after last `}`.
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end < 0) return []
  s = s.slice(start, end + 1)
  try {
    const obj = JSON.parse(s) as { facts?: ExtractedFact[] }
    return Array.isArray(obj.facts) ? obj.facts : []
  } catch {
    return []
  }
}

function normalizeCategory(c: unknown): FactCategory {
  const v = typeof c === 'string' ? c.toLowerCase() : ''
  if (v === 'preference' || v === 'goal' || v === 'history' || v === 'profile') return v
  return 'fact'
}

function clampConfidence(c: unknown): number {
  const n = typeof c === 'number' ? c : Number(c)
  if (!Number.isFinite(n)) return 0.6
  return Math.max(0, Math.min(1, n))
}

/**
 * Run extraction synchronously. Returns the number of facts saved (or 0).
 * Errors are caught and logged; never thrown to the caller.
 */
export async function runDistillation(input: DistillationInput): Promise<number> {
  if (!isMemoryEnabled()) return 0
  if (!input.platform || !input.userId) return 0
  const min = input.minLen ?? DEFAULT_MIN_LEN
  if (input.userMessage.trim().length < min && input.agentReply.trim().length < min) {
    return 0
  }
  const key = userKey(input.platform, input.userId)
  const source = input.traceId ? `trace:${input.traceId}` : 'auto'
  const traceId = input.traceId || `distill-${Date.now()}`

  // Single-shot extraction. Two paths:
  //   1. Preferred (D+ Stage 1): native LLM backend configured for the
  //      'cheap' role — direct HTTP call, no CLI spawn, completes in
  //      ~200ms instead of seconds.
  //   2. Fallback: the agent that just produced the reply. Keeps
  //      behaviour identical to pre-D+ deployments and operators who
  //      run agim without any LLM backend configured.
  //
  // We use a synthetic session id so the agent doesn't pollute the
  // user's real conversation history.
  const extractionPrompt = buildExtractionPrompt(input.userMessage, input.agentReply)
  let raw = ''
  let costAccum = 0
  const startedAt = Date.now()
  let agentFailed: Error | null = null
  let usedAgentName: string = input.agent.name

  const nativeResult = await tryIntrospect({
    role: 'cheap',
    prompt: extractionPrompt,
    timeoutMs: 30_000,
    temperature: 0.2,
  })

  if (nativeResult) {
    raw = nativeResult.text
    if (typeof nativeResult.usage.costUsd === 'number') costAccum = nativeResult.usage.costUsd
    usedAgentName = `llm:${nativeResult.backendName}`
  } else {
    try {
      const gen = input.agent.sendPrompt(`memory-distill-${Date.now()}`, extractionPrompt, [], {
        // platform='memory-distill' keeps distill rows separate from real IM
        // turns in the audit view (and in Cost & Health pivots).
        platform: 'memory-distill',
        userId: input.userId,
        // P1-5: account for distill cost so Cost & Health reports the true
        // operator spend, not just user-facing turns.
        onUsage: (delta) => {
          if (typeof delta.costUsd === 'number' && Number.isFinite(delta.costUsd)) {
            costAccum += delta.costUsd
          }
        },
      })
      for await (const chunk of gen) {
        raw += chunk
        if (raw.length > 8000) break  // safety cap; extraction output is small
      }
    } catch (err) {
      agentFailed = err instanceof Error ? err : new Error(String(err))
      log.warn({ event: 'memory.distill.agent_failed', err: String(err) })
    }
  }

  // Audit every distill attempt — success or failure — so operators can
  // see how often distillation runs, what it costs, and when it errors.
  // intent='memory.distill' makes it filterable in the dashboard.
  // The agent field uses `llm:<backend>` for native calls so the cost
  // dashboard can pivot CLI vs LLM spend.
  try {
    logInvocation({
      traceId,
      userId: input.userId,
      platform: 'memory-distill',
      agent: usedAgentName,
      intent: 'memory.distill',
      promptLen: extractionPrompt.length,
      responseLen: raw.length,
      durationMs: Date.now() - startedAt,
      cost: costAccum,
      success: agentFailed === null,
      error: agentFailed?.message,
    })
  } catch { /* audit best-effort */ }

  if (agentFailed) return 0
  if (!raw.trim()) {
    log.debug({ event: 'memory.distill.empty_output' })
    return 0
  }
  const extracted = tryParseFactsJson(raw)
  if (extracted.length === 0) {
    log.debug({ event: 'memory.distill.no_facts', rawPreview: raw.slice(0, 200) })
    return 0
  }
  let saved = 0
  for (const ef of extracted) {
    if (typeof ef.what !== 'string' || !ef.what.trim()) continue
    const id = saveFact({
      user_key: key,
      what: ef.what.trim().slice(0, 500),
      who: typeof ef.who === 'string' ? ef.who.slice(0, 200) : '',
      when_text: typeof ef.when_text === 'string' ? ef.when_text.slice(0, 200) : '',
      where_label: typeof ef.where_label === 'string' ? ef.where_label.slice(0, 200) : '',
      why: typeof ef.why === 'string' ? ef.why.slice(0, 500) : '',
      category: normalizeCategory(ef.category),
      confidence: clampConfidence(ef.confidence),
      source,
    })
    if (id !== null) saved++
  }
  log.info({ event: 'memory.distill.done', saved, attempted: extracted.length, user_key: key })
  return saved
}

/**
 * Fire-and-forget wrapper. Schedules runDistillation() on the next tick so
 * the caller doesn't block. Returns immediately. Use this from router/cli
 * post-reply hooks.
 */
export function scheduleDistillation(input: DistillationInput): void {
  if (!isMemoryEnabled()) return
  setImmediate(() => {
    void runDistillation(input).catch((err) => {
      log.warn({ event: 'memory.distill.scheduled_failed', err: String(err) })
    })
  })
}

