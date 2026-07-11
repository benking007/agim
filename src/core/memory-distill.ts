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
import { saveFact, findFactIdByWhat, touchFact, userKey, enqueuePendingTurn, type FactCategory } from './memory.js'
import { isMemoryEnabled } from './persona.js'
import { logInvocation } from './audit-log.js'
import { tryIntrospect } from './llm/index.js'
import { registry } from './registry.js'

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

export interface TurnPair { user_message: string; agent_reply: string }

// Prompt for BATCH fact extraction across N buffered turns. Returns JSON; we
// parse defensively (the LLM occasionally wraps in markdown fences). Batching
// lets the model dedup / resolve contradictions across the whole session.
function buildBatchExtractionPrompt(turns: TurnPair[]): string {
  const convo: string[] = []
  turns.forEach((t, i) => {
    convo.push(`### 第 ${i + 1} 轮`)
    convo.push(`用户：${t.user_message.slice(0, 2000)}`)
    convo.push(`Agent：${t.agent_reply.slice(0, 2000)}`)
    convo.push('')
  })
  return [
    `你是一个事实抽取器。下面是与同一个用户的 ${turns.length} 轮对话。`,
    '从【整段对话】中提取最多 8 条**值得长期记住的事实**：跨轮去重、合并相似项、矛盾时保留最新。',
    '输出严格的 JSON，**不要任何额外文字 / markdown / 解释**：',
    '',
    '{"facts":[{"what":"用户偏好早 8 点喝咖啡","category":"preference","confidence":0.8,"who":"user","when_text":"","where_label":"","why":""}]}',
    '',
    '字段：what 必填(1 句话) · category ∈ fact|preference|goal|history|profile · confidence 0-1 · who/when_text/where_label/why 可选。',
    '',
    '严格执行：',
    '- **跳过寒暄 / 测试消息 / 临时性信息**（如"在不在"、"明天再说"）',
    '- 只挑可在未来对话里**复用**的事实；不要总结整段对话',
    '- 用户没说的事**不要编造**（confidence 必须基于实际证据）',
    '- 没有值得记的就**返回 `{"facts": []}`**',
    '- 输出**纯 JSON，不要 markdown 围栏**',
    '',
    '## 对话',
    ...convo,
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

type DistillSource = 'auto' | 'agent' | 'llm'
function distillSource(): DistillSource {
  const v = (process.env.AGIM_MEMORY_DISTILL_SOURCE || 'auto').toLowerCase()
  return v === 'agent' || v === 'llm' ? v : 'auto'
}

// Resolve + run the extraction LLM per the configured source:
//   auto  → the batch's representative agent (zero-config default)
//   agent → AGIM_MEMORY_DISTILL_AGENT (a chosen, already-enabled agent)
//   llm   → the `distill` LLM role (direct HTTP, no CLI spawn)
// Returns raw model output + an audit name, or null when no usable LLM is
// available (caller then keeps the turns buffered to retry next pass).
async function runExtractionLlm(
  prompt: string, representativeAgent: string,
): Promise<{ text: string; usedName: string; costUsd: number } | null> {
  const src = distillSource()
  if (src === 'llm') {
    const r = await tryIntrospect({ role: 'distill', prompt, timeoutMs: 30_000, temperature: 0.2 })
    if (!r) { log.warn({ event: 'memory.distill.no_distill_backend' }); return null }
    return { text: r.text, usedName: `llm:${r.backendName}`, costUsd: typeof r.usage.costUsd === 'number' ? r.usage.costUsd : 0 }
  }
  const agentName = (src === 'agent' ? (process.env.AGIM_MEMORY_DISTILL_AGENT || '') : representativeAgent).trim()
  if (!agentName) { log.warn({ event: 'memory.distill.no_agent', src }); return null }
  const agent = registry.getAgent(agentName)
  if (!agent) { log.warn({ event: 'memory.distill.agent_missing', agentName }); return null }
  let raw = ''
  let cost = 0
  try {
    const gen = agent.sendPrompt(`memory-distill-${Date.now()}`, prompt, [], {
      // platform='memory-distill' keeps distill rows out of real IM history /
      // audit pivots; userId is synthetic so it never pollutes a user thread.
      platform: 'memory-distill',
      userId: 'distill',
      onUsage: (d) => { if (typeof d.costUsd === 'number' && Number.isFinite(d.costUsd)) cost += d.costUsd },
    })
    const cap = Date.now() + 30_000
    for await (const chunk of gen) { raw += chunk; if (raw.length > 8000 || Date.now() > cap) break }
  } catch (err) {
    log.warn({ event: 'memory.distill.agent_failed', agentName, err: String(err) })
    return null
  }
  return { text: raw, usedName: agentName, costUsd: cost }
}

/** Parse the model's JSON output and persist facts, with write-time dedup by
 *  exact `what` (re-confirmed facts are touched, not duplicated). Returns the
 *  count of NEW facts saved. */
function parseAndSaveFacts(raw: string, key: string, source: string): number {
  const extracted = tryParseFactsJson(raw)
  if (extracted.length === 0) {
    log.debug({ event: 'memory.distill.no_facts', rawPreview: raw.slice(0, 200) })
    return 0
  }
  let saved = 0
  let deduped = 0
  for (const ef of extracted) {
    if (typeof ef.what !== 'string' || !ef.what.trim()) continue
    const what = ef.what.trim().slice(0, 500)
    const existingId = findFactIdByWhat(key, what)
    if (existingId !== null) { touchFact(existingId); deduped++; continue }
    const id = saveFact({
      user_key: key,
      what,
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
  log.info({ event: 'memory.distill.saved', saved, deduped, attempted: extracted.length, user_key: key })
  return saved
}

export interface BatchResult { ok: boolean; saved: number }

/**
 * Extract + save facts from a batch of buffered turns for one user.
 * `ok=true` means the LLM ran and its output parsed — safe to clear the buffer
 * even if 0 facts were worth keeping. `ok=false` means no usable LLM, so the
 * caller should keep the turns and retry on the next pass.
 */
export async function runBatchDistillation(
  key: string,
  turns: TurnPair[],
  representativeAgent: string,
): Promise<BatchResult> {
  if (!isMemoryEnabled() || turns.length === 0) return { ok: false, saved: 0 }
  const prompt = buildBatchExtractionPrompt(turns)
  const startedAt = Date.now()
  const res = await runExtractionLlm(prompt, representativeAgent)
  // Audit every attempt (success or "no LLM") for the Cost & Health dashboard.
  try {
    logInvocation({
      traceId: `distill-${startedAt}`,
      userId: key,
      platform: 'memory-distill',
      agent: res?.usedName ?? 'none',
      intent: 'memory.distill',
      promptLen: prompt.length,
      responseLen: res?.text.length ?? 0,
      durationMs: Date.now() - startedAt,
      cost: res?.costUsd ?? 0,
      success: res !== null,
      error: res ? undefined : 'no usable distill LLM',
    })
  } catch { /* audit best-effort */ }
  if (!res) return { ok: false, saved: 0 }
  if (!res.text.trim()) return { ok: true, saved: 0 }
  return { ok: true, saved: parseAndSaveFacts(res.text, key, 'distill') }
}

/**
 * Single-turn distillation (direct/legacy entry). Delegates to the batch path
 * with a one-turn batch. The hot path no longer calls this — it buffers via
 * scheduleDistillation and the background distiller batches.
 */
export async function runDistillation(input: DistillationInput): Promise<number> {
  if (!isMemoryEnabled()) return 0
  if (!input.platform || !input.userId) return 0
  const min = input.minLen ?? DEFAULT_MIN_LEN
  if (input.userMessage.trim().length < min && input.agentReply.trim().length < min) return 0
  const key = userKey(input.platform, input.userId)
  const r = await runBatchDistillation(
    key,
    [{ user_message: input.userMessage, agent_reply: input.agentReply }],
    input.agent?.name ?? '',
  )
  return r.saved
}

function maxPending(): number {
  const raw = process.env.AGIM_MEMORY_DISTILL_MAX_PENDING
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200
}

/**
 * Post-reply hook (router.ts). Dream distillation: just BUFFER the turn on the
 * hot path (a single SQLite insert, zero LLM). The background distiller
 * (memory-distiller.ts) batch-extracts buffered turns when the system is idle.
 * Trivial exchanges ("ok" / "thanks") are skipped. Returns immediately.
 */
export function scheduleDistillation(input: DistillationInput): void {
  if (!isMemoryEnabled()) return
  if (!input.platform || !input.userId) return
  const min = input.minLen ?? DEFAULT_MIN_LEN
  if (input.userMessage.trim().length < min && input.agentReply.trim().length < min) return
  try {
    enqueuePendingTurn({
      user_key: userKey(input.platform, input.userId),
      platform: input.platform,
      user_message: input.userMessage,
      agent_reply: input.agentReply,
      agent_name: input.agent?.name ?? '',
      trace_id: input.traceId,
    }, maxPending())
  } catch (err) {
    log.debug({ event: 'memory.distill.enqueue_failed', err: String(err) })
  }
}

