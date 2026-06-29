// memory-consolidate — daily(-ish) per-user job that rebuilds each
// persona_profile from accumulated facts.
//
// Why a separate pass: distillation writes raw facts append-only ("user
// likes coffee" might land 3 times in a week). Persona is the small
// always-injected summary; we don't want it to grow unboundedly. The
// consolidation prompt distils {facts} → a ≤300-token Chinese/English
// summary, dropping dupes and resolving contradictions.
//
// Agent choice:
//   - Look at audit-log for the user's most recently used agent.
//   - If none in the last 30 days, skip — user is inactive, no point.
//   - Resolve agent via registry; skip + log if not registered (agent was
//     removed from config).
//
// Throttling:
//   - One LLM call per active user, run interval-spaced via setInterval at
//     startup. Default 24h, env AGIM_MEMORY_CONSOLIDATE_HOURS.
//   - For agim instances with many users, this batches naturally — each
//     run picks up where we left off.

import { logger as rootLogger } from './logger.js'
import { registry } from './registry.js'
import {
  listRecentFacts,
  upsertPersona,
  type Fact,
} from './memory.js'
import { isMemoryEnabled } from './persona.js'
import { tryIntrospect } from './llm/index.js'

const log = rootLogger.child({ component: 'memory-consolidate' })

const MAX_FACTS_PER_USER = 80      // cap input size to keep prompt cheap
const PERSONA_TARGET_CHARS = 600   // ~300 tokens give or take
const PROMPT_TIMEOUT_MS = 60_000

function intervalMs(): number {
  const raw = process.env.AGIM_MEMORY_CONSOLIDATE_HOURS
  if (raw) {
    const h = Number(raw)
    if (Number.isFinite(h) && h > 0) return h * 3600_000
  }
  return 24 * 3600_000
}

function isMemoryConsolidateEnabled(): boolean {
  // Master toggle pairs with AGIM_MEMORY_ENABLED but can be turned off
  // separately for operators who want distillation but no consolidation
  // (e.g. very long retention, manual persona edits).
  if (!isMemoryEnabled()) return false
  const raw = (process.env.AGIM_MEMORY_CONSOLIDATE_ENABLED || '1').toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no'
}

function buildConsolidationPrompt(facts: Fact[]): string {
  const lines: string[] = []
  for (const f of facts) {
    const meta = [
      f.category,
      `conf=${f.confidence.toFixed(2)}`,
      f.who ? `who=${f.who}` : '',
      f.when_text ? `when=${f.when_text}` : '',
      f.where_label ? `where=${f.where_label}` : '',
      f.why ? `why=${f.why}` : '',
    ].filter(Boolean).join(' · ')
    lines.push(`- [${meta}] ${f.what}`)
  }
  return [
    `你是一个 persona 摘要编辑器。任务：把下面 ${facts.length} 条事实合并成**不超过 ${PERSONA_TARGET_CHARS} 个字符**的中文 persona 摘要，给未来的对话引用。`,
    '',
    '规则：',
    `- 去重 / 合并相似事实（"用户在杭州" + "用户在杭州工作" → 一句话）`,
    '- 矛盾事实保留最新的，标"(目前)"',
    '- 优先 category=profile / preference / goal，category=history 仅写最新',
    '- 用清晰的小段落或要点列出，不要散文式叙述',
    `- 严格 ≤ ${PERSONA_TARGET_CHARS} 字符`,
    '- 输出**纯文本摘要，不要 markdown 围栏，不要任何解释**',
    '',
    '事实列表：',
    ...lines,
    '',
    '现在请输出 persona 摘要：',
  ].join('\n')
}

async function consolidateOneUser(userKey: string, agentName: string): Promise<boolean> {
  const facts = listRecentFacts(userKey, MAX_FACTS_PER_USER)
  if (facts.length === 0) return false

  const prompt = buildConsolidationPrompt(facts)
  let raw = ''

  // D+ Stage 1: prefer a configured native LLM backend ('cheap' role).
  // Falls back to the user's recent CLI agent on no-backend or failure
  // so historical behaviour is preserved when llmBackends is empty.
  const nativeResult = await tryIntrospect({
    role: 'cheap',
    prompt,
    timeoutMs: PROMPT_TIMEOUT_MS,
    temperature: 0.2,
  })
  if (nativeResult) {
    raw = nativeResult.text
  } else {
    const agent = registry.getAgent(agentName)
    if (!agent) {
      log.warn({ event: 'memory.consolidate.agent_missing', agentName, userKey })
      return false
    }
    try {
      const gen = agent.sendPrompt(`memory-consolidate-${Date.now()}`, prompt, [], {
        platform: 'memory-consolidate',
        userId: userKey,
      })
      const deadline = Date.now() + PROMPT_TIMEOUT_MS
      for await (const chunk of gen) {
        raw += chunk
        if (Date.now() > deadline) break
        if (raw.length > PERSONA_TARGET_CHARS * 4) break  // safety cap
      }
    } catch (err) {
      log.warn({ event: 'memory.consolidate.agent_failed', userKey, agentName, err: String(err) })
      return false
    }
  }

  let summary = raw.trim()
  if (!summary) return false
  // Strip optional code fences the model added despite instructions.
  const fence = summary.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
  if (fence) summary = fence[1].trim()
  if (summary.length > PERSONA_TARGET_CHARS * 2) {
    // Hard truncate at 2x target to avoid runaway summaries.
    summary = `${summary.slice(0, PERSONA_TARGET_CHARS * 2)}…`
  }

  const ok = upsertPersona(userKey, summary)
  if (ok) {
    log.info({
      event: 'memory.consolidate.upserted',
      userKey, agentName, factsConsidered: facts.length, summaryLen: summary.length,
    })
  }
  return ok
}

interface UserAgentSnapshot {
  user_key: string
  recentAgent: string | null
}

/**
 * Find each user_key that has facts + which agent they used last (so we
 * call the right one for consolidation). Reads facts.user_key as the
 * authoritative user list; cross-references audit-log for agent affinity.
 */
async function listActiveUsersWithAgent(): Promise<UserAgentSnapshot[]> {
  const { default: Database } = await import('better-sqlite3')
  const { MEMORY_DB_PATH } = await import('./memory.js')
  const { AGIM_HOME } = await import('./agim-paths.js')
  const { join } = await import('node:path')
  const auditDbPath = join(AGIM_HOME, 'audit.db')
  let memDb: import('better-sqlite3').Database | null = null
  let auditDb: import('better-sqlite3').Database | null = null
  try {
    memDb = new Database(MEMORY_DB_PATH, { readonly: true })
    auditDb = new Database(auditDbPath, { readonly: true })
  } catch (err) {
    log.warn({ event: 'memory.consolidate.db_open_failed', err: String(err) })
    if (memDb) memDb.close()
    if (auditDb) auditDb.close()
    return []
  }

  try {
    const users = memDb.prepare(`
      SELECT user_key, COUNT(*) AS n FROM facts GROUP BY user_key HAVING n > 0
    `).all() as Array<{ user_key: string; n: number }>

    const out: UserAgentSnapshot[] = []
    for (const u of users) {
      // user_key shape = `${platform}:${userId}`. Same composite is used by
      // audit-log's `platform` + `user_id` cols, so split & query.
      const sep = u.user_key.indexOf(':')
      if (sep < 0) { out.push({ user_key: u.user_key, recentAgent: null }); continue }
      const platform = u.user_key.slice(0, sep)
      const userId = u.user_key.slice(sep + 1)
      let recentAgent: string | null = null
      try {
        const row = auditDb.prepare(`
          SELECT agent FROM invocations
          WHERE platform = ? AND user_id = ?
            AND ts >= datetime('now', '-30 days')
            AND agent != ''
          ORDER BY ts DESC LIMIT 1
        `).get(platform, userId) as { agent: string } | undefined
        if (row?.agent) recentAgent = row.agent
      } catch { /* fallthrough */ }
      out.push({ user_key: u.user_key, recentAgent })
    }
    return out
  } finally {
    memDb.close()
    auditDb.close()
  }
}

/**
 * One pass: consolidate every active user. Returns { users, updated }.
 * Safe to call manually (e.g. from a CLI / /memory consolidate command).
 */
export async function runConsolidationOnce(): Promise<{ users: number; updated: number }> {
  if (!isMemoryConsolidateEnabled()) return { users: 0, updated: 0 }
  const snapshots = await listActiveUsersWithAgent()
  let updated = 0
  for (const s of snapshots) {
    if (!s.recentAgent) {
      log.debug({ event: 'memory.consolidate.skip_inactive', userKey: s.user_key })
      continue
    }
    try {
      const ok = await consolidateOneUser(s.user_key, s.recentAgent)
      if (ok) updated++
    } catch (err) {
      log.warn({ event: 'memory.consolidate.user_failed', userKey: s.user_key, err: String(err) })
    }
  }
  log.info({ event: 'memory.consolidate.pass_done', users: snapshots.length, updated })
  return { users: snapshots.length, updated }
}

// Module-level interval handle for stopMemoryConsolidator().
let timer: NodeJS.Timeout | null = null

/** Start the periodic consolidator. Idempotent; safe to call once at boot. */
export function startMemoryConsolidator(): void {
  if (timer) return
  const period = intervalMs()
  log.info({ event: 'memory.consolidate.start', periodHours: period / 3600_000 })
  // Don't run immediately at boot — wait one period so we don't compete
  // with the user's first inbound message. Tests can override by calling
  // runConsolidationOnce directly.
  timer = setInterval(() => {
    if (!isMemoryConsolidateEnabled()) return
    void runConsolidationOnce().catch((err) => {
      log.warn({ event: 'memory.consolidate.tick_failed', err: String(err) })
    })
  }, period)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as { unref: () => void }).unref()
  }
}

export function stopMemoryConsolidator(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
