// memory-rpc — handles memory_query / memory_save / memory_list / memory_delete
// invocations relayed by the approval-bus from MCP sidecars.
//
// Same wire pattern as reminder-rpc / push-rpc. Stateless: every op reads /
// writes via src/core/memory.ts. Context resolution (which user owns the
// memory) is the caller's RunContext from the approval-bus.

import { logger as rootLogger } from './logger.js'
import {
  saveFact,
  queryFacts,
  queryFactsHybrid,
  listRecentFacts,
  deleteFact,
  userKey,
  type FactCategory,
} from './memory.js'
import type { RunContext } from './approval-bus.js'

const log = rootLogger.child({ component: 'memory-rpc' })

export type MemoryOp = 'query' | 'save' | 'list' | 'delete'

export type MemoryResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
function asNumber(v: unknown): number | undefined {
  if (typeof v !== 'number') return undefined
  if (!Number.isFinite(v)) return undefined
  return v
}

export async function handleMemoryOp(
  op: string,
  payload: Record<string, unknown>,
  ctx: RunContext,
): Promise<MemoryResult> {
  if (!ctx.userId) return { ok: false, error: 'memory ops require a userId in context' }
  const key = userKey(ctx.platform, ctx.userId)

  try {
    if (op === 'query') {
      const query = asString(payload.query) ?? ''
      const category = asString(payload.category) as FactCategory | undefined
      const k = asNumber(payload.k) ?? 5
      // v1.6 — auto hybrid (FTS5 + vector RRF) when vector backend ready,
      // falls back to plain FTS5 otherwise. Always async because backend
      // may take time on first embed.
      const r = query
        ? await queryFactsHybrid({ user_key: key, query, category, k })
        : queryFacts({ user_key: key, category, k })
      return {
        ok: true,
        result: {
          matched: r.matched,
          facts: r.facts.map((f) => ({
            id: f.id, what: f.what, who: f.who, when_text: f.when_text,
            where_label: f.where_label, why: f.why,
            category: f.category, confidence: f.confidence,
            created_at: new Date(f.created_at * 1000).toISOString(),
          })),
        },
      }
    }

    if (op === 'save') {
      const what = asString(payload.what)
      if (!what) return { ok: false, error: 'what is required (non-empty string)' }
      const id = saveFact({
        user_key: key,
        what,
        who: asString(payload.who),
        when_text: asString(payload.when_text),
        where_label: asString(payload.where_label),
        why: asString(payload.why),
        category: (asString(payload.category) as FactCategory | undefined) ?? 'fact',
        confidence: asNumber(payload.confidence),
        source: 'manual',
      })
      if (id === null) return { ok: false, error: 'failed to persist fact (sqlite unavailable?)' }
      return { ok: true, result: { id } }
    }

    if (op === 'list') {
      const limit = asNumber(payload.limit) ?? 50
      const rows = listRecentFacts(key, limit)
      return {
        ok: true,
        result: rows.map((f) => ({
          id: f.id, what: f.what, who: f.who, when_text: f.when_text,
          where_label: f.where_label, why: f.why,
          category: f.category, confidence: f.confidence,
          created_at: new Date(f.created_at * 1000).toISOString(),
        })),
      }
    }

    if (op === 'delete') {
      const id = asNumber(payload.id)
      if (id === undefined) return { ok: false, error: 'id is required (number)' }
      const ok = deleteFact(id, key)
      return { ok: true, result: { deleted: ok } }
    }

    return { ok: false, error: `unknown memory op: ${op}` }
  } catch (err) {
    log.warn({ event: 'memory.rpc.failed', op, err: String(err) })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
