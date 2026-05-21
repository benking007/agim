// memory — long-term agent memory: persona profiles + fact store.
//
// Two tables, one SQLite file (~/.agim/memory.db):
//
//   persona_profile (user_key, summary, updated_at)
//     One row per user. `summary` is a 150-300 token Chinese/English
//     distilled snapshot rebuilt by daily consolidation. Always injected
//     into agent prompts (when present) via router.ts → buildPersonaSnippet.
//
//   facts (id, user_key, what, who, when_text, where_label, why, category,
//          confidence, last_referenced_at, source, created_at)
//     Append-only fact store. Records written by memory-distill.ts after
//     each agent turn + manual saves from /memo or memory_save MCP. Read
//     via memory_query (hybrid FTS5 + recency) when agent decides to query.
//
//     `user_key` = `${platform}:${userId}` so a single human across multiple
//     IMs converges to the same memory if userId is consistent. Otherwise
//     each IM persona is independent.
//
// Vector index (sqlite-vss) is **optional** for v1.5 — when the extension
// isn't loaded the helper falls back to FTS5-only retrieval. Vector adds
// quality, not correctness.

import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { createSqliteHelper } from './sqlite-helper.js'
import { AGIM_HOME } from './agim-paths.js'

const MEMORY_DB = join(AGIM_HOME, 'memory.db')
const log = rootLogger.child({ component: 'memory' })

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS persona_profile (
    user_key   TEXT PRIMARY KEY,
    summary    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS facts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key            TEXT NOT NULL,
    what                TEXT NOT NULL,
    who                 TEXT DEFAULT '',
    when_text           TEXT DEFAULT '',
    where_label         TEXT DEFAULT '',
    why                 TEXT DEFAULT '',
    category            TEXT NOT NULL DEFAULT 'fact',
    confidence          REAL NOT NULL DEFAULT 0.6,
    last_referenced_at  INTEGER NOT NULL,
    source              TEXT DEFAULT '',
    created_at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_facts_cat  ON facts(user_key, category);

  -- FTS5 virtual table for keyword retrieval. Tokenizer porter handles
  -- English stemming; CJK characters are indexed as bigrams via unicode61
  -- if available. We compose the indexed text from the 5W1H slots.
  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    user_key UNINDEXED,
    text,
    content='',
    tokenize='unicode61'
  );
`

/** v1.6 — vector retrieval columns (added via ALTER, idempotent). */
function migrateVectorColumns(db: import('better-sqlite3').Database): void {
  const cols = db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>
  const have = new Set(cols.map((c) => c.name))
  const adds: Array<[string, string]> = []
  if (!have.has('embedding'))        adds.push(['embedding',        'BLOB'])
  if (!have.has('embedding_model'))  adds.push(['embedding_model',  'TEXT'])
  if (!have.has('embedding_dims'))   adds.push(['embedding_dims',   'INTEGER'])
  if (!have.has('embedded_at'))      adds.push(['embedded_at',      'INTEGER'])
  for (const [col, type] of adds) {
    try {
      db.prepare(`ALTER TABLE facts ADD COLUMN ${col} ${type}`).run()
    } catch (err) {
      // Concurrent migration (different process) — ignore "duplicate column" error.
      if (!/duplicate column name/i.test(String(err))) {
        rootLogger.warn({ event: 'memory.migrate_failed', col, err: String(err) })
      }
    }
  }
}

/** Default retention windows. 0 disables → permanent (back-compat). */
function resolveFactRetentionDays(): number {
  const raw = process.env.IMHUB_MEMORY_FACT_RETENTION_DAYS
  if (raw === undefined) return 90
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 90
  return n
}
function resolvePersonaRetentionDays(): number {
  const raw = process.env.IMHUB_PERSONA_RETENTION_DAYS
  if (raw === undefined) return 180
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 180
  return n
}

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 hours
let sweepTimer: ReturnType<typeof setInterval> | null = null

const helper = createSqliteHelper({
  file: MEMORY_DB,
  schema: SCHEMA,
  logger: log,
  component: 'memory',
  init: (d) => {
    migrateVectorColumns(d)
    // R12 ② — TTL sweep on startup + every 6 hours. With LRU semantics
    // (uses last_referenced_at, not created_at) so frequently-queried
    // facts survive. Set retention to 0 to disable.
    try { pruneExpiredFactsInternal(d) } catch (err) {
      log.warn({ event: 'memory.prune_facts_init_failed', err: String(err) })
    }
    try { pruneExpiredPersonaInternal(d) } catch (err) {
      log.warn({ event: 'memory.prune_persona_init_failed', err: String(err) })
    }
    if (RETENTION_SWEEP_INTERVAL_MS > 0 && sweepTimer === null) {
      sweepTimer = setInterval(() => {
        const live = helper.get()
        if (!live) return
        try { pruneExpiredFactsInternal(live) } catch { /* logged inside */ }
        try { pruneExpiredPersonaInternal(live) } catch { /* logged inside */ }
      }, RETENTION_SWEEP_INTERVAL_MS)
      if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
        (sweepTimer as { unref: () => void }).unref()
      }
    }
  },
})

export type FactCategory = 'fact' | 'preference' | 'goal' | 'history' | 'profile'

export interface Fact {
  id: number
  user_key: string
  what: string
  who: string
  when_text: string
  where_label: string
  why: string
  category: FactCategory
  confidence: number
  last_referenced_at: number
  source: string
  created_at: number
}

export interface SaveFactInput {
  user_key: string
  what: string
  who?: string
  when_text?: string
  where_label?: string
  why?: string
  category?: FactCategory
  confidence?: number
  source?: string
}

export function userKey(platform: string, userId: string): string {
  return `${platform}:${userId || 'anon'}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * CJK tokenization helper. FTS5's `unicode61` tokenizer treats a run of
 * adjacent CJK characters as a single token (e.g. "用户在杭州工作" → one
 * token), so a query for "杭州" never matches. We force per-character
 * boundaries on both the indexed text AND the query string so each CJK
 * character becomes its own token; multi-char queries then match via
 * FTS5's implicit AND across tokens.
 *
 * Range covers: CJK Unified Ideographs (4E00–9FFF), CJK Extension A
 * (3400–4DBF), Hiragana (3040–309F), Katakana (30A0–30FF),
 * Hangul Syllables (AC00–D7AF).
 */
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/
function cjkSeparate(s: string): string {
  // Insert a space after every CJK char that is immediately followed by
  // another non-space character (CJK or ASCII). Cheap; runs over short text.
  let out = ''
  for (let i = 0; i < s.length; i++) {
    out += s[i]
    if (CJK_RE.test(s[i]) && i + 1 < s.length && s[i + 1] !== ' ') out += ' '
  }
  return out
}

/**
 * Flatten a fact's 5W1H slots into a single string for FTS5 indexing.
 * Repeats `what` twice so it dominates rank — that's the primary content.
 */
function indexableText(f: SaveFactInput): string {
  const raw = [f.what, f.what, f.who, f.when_text, f.where_label, f.why]
    .filter(Boolean)
    .join(' · ')
  return cjkSeparate(raw)
}

/**
 * Build a safe FTS5 MATCH expression from arbitrary user input.
 * Wrapping in a quoted phrase neutralizes operators (`AND`, `OR`, `:`,
 * `(`, `*`, `+`, etc.) that would otherwise crash the prepared statement.
 * Internal double-quotes are replaced with spaces (rare in fact text).
 * Also CJK-separates so per-char tokens match per-char indexed tokens.
 */
function buildFtsMatch(q: string): string {
  const sep = cjkSeparate(q.replace(/"/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  if (!sep) return ''
  return `"${sep}"`
}

export function saveFact(input: SaveFactInput): number | null {
  const db = helper.get()
  if (!db) return null
  const ts = nowSec()
  try {
    const text = indexableText(input)
    // Wrap the two inserts in a transaction — without this, a crash
    // between row and FTS insert leaves the FTS index out of sync.
    const id = db.transaction((): number => {
      const r = db.prepare(`
        INSERT INTO facts (user_key, what, who, when_text, where_label, why, category, confidence, last_referenced_at, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.user_key,
        input.what,
        input.who ?? '',
        input.when_text ?? '',
        input.where_label ?? '',
        input.why ?? '',
        input.category ?? 'fact',
        Math.max(0, Math.min(1, input.confidence ?? 0.6)),
        ts,
        input.source ?? '',
        ts,
      )
      const factId = Number(r.lastInsertRowid)
      db.prepare('INSERT INTO facts_fts(rowid, user_key, text) VALUES (?, ?, ?)')
        .run(factId, input.user_key, text)
      return factId
    })()
    // v1.6 — async embed + write to embedding column. Non-blocking — fact
    // is already persisted, vector is a soft add. If the backend is off /
    // not ready / network fails, the fact still works (falls back to FTS5
    // on query). setImmediate ensures we don't hold the caller.
    setImmediate(() => { void embedAndStoreFact(id, text) })
    return id
  } catch (err) {
    log.warn({ event: 'memory.save_failed', err: String(err) })
    return null
  }
}

// Process-lifetime flag so we warn at most once when the vector backend
// is enabled in env but not actually usable (model not downloaded, no key,
// etc.). Without this, every saveFact would silently skip the embed step
// and users would be confused why memory_query falls back to FTS5-only.
let _embedNotReadyWarned = false

async function embedAndStoreFact(factId: number, text: string): Promise<void> {
  try {
    const { getActiveBackend, float32ToBuffer } = await import('./memory-vector.js')
    const backend = getActiveBackend()
    if (!backend.ready) {
      if (backend.name !== 'off' && !_embedNotReadyWarned) {
        _embedNotReadyWarned = true
        log.info({
          event: 'memory.embed.backend_not_ready',
          backend: backend.name, modelId: backend.modelId,
        }, 'vector backend configured but not ready — facts saved without embeddings; run /memory backfill once it becomes ready')
      }
      return
    }
    const vecs = await backend.embed([text])
    const v = vecs[0]
    if (!v || v.length === 0) return
    const db = helper.get()
    if (!db) return
    db.prepare(`
      UPDATE facts SET embedding = ?, embedding_model = ?, embedding_dims = ?, embedded_at = ?
      WHERE id = ?
    `).run(float32ToBuffer(v), `${backend.name}:${backend.modelId}`, v.length, nowSec(), factId)
  } catch (err) {
    // Embedding failures must never break fact storage. Already persisted.
    log.debug({ event: 'memory.embed_async_failed', factId, err: String(err) })
  }
}

export function deleteFact(id: number, user_key: string): boolean {
  const db = helper.get()
  if (!db) return false
  try {
    return db.transaction((): boolean => {
      // facts_fts is contentless (content=''), so a plain
      // `DELETE FROM facts_fts WHERE rowid = ?` throws
      // "cannot DELETE from contentless fts5 table". The canonical way
      // to remove a row from a contentless FTS5 index is the
      // `INSERT INTO <fts>(<fts>, rowid, <columns>) VALUES('delete', ...)`
      // command — the values must match what was indexed (so SQLite can
      // subtract the per-term counts). We rebuild that text from the
      // row's 5W1H slots using the same indexableText() saveFact used.
      const row = db
        .prepare('SELECT what, who, when_text, where_label, why FROM facts WHERE id = ? AND user_key = ?')
        .get(id, user_key) as
        | { what: string; who: string | null; when_text: string | null; where_label: string | null; why: string | null }
        | undefined
      const r = db.prepare('DELETE FROM facts WHERE id = ? AND user_key = ?').run(id, user_key)
      if (r.changes > 0 && row) {
        const text = indexableText({
          user_key,
          what: row.what,
          who: row.who ?? '',
          when_text: row.when_text ?? '',
          where_label: row.where_label ?? '',
          why: row.why ?? '',
        })
        db.prepare(
          "INSERT INTO facts_fts(facts_fts, rowid, user_key, text) VALUES ('delete', ?, ?, ?)",
        ).run(id, user_key, text)
      }
      return r.changes > 0
    })()
  } catch (err) {
    log.warn({ event: 'memory.delete_failed', err: String(err) })
    return false
  }
}

export interface QueryOpts {
  user_key: string
  query?: string
  category?: FactCategory
  k?: number
}

export interface QueryResult {
  facts: Fact[]
  matched: number
}

/**
 * Hybrid retrieval. v1.5 first cut uses FTS5 + recency boost; v1.6 will
 * layer in sqlite-vss dense vectors and rerank.
 *
 *  - Empty query → most-recent N facts.
 *  - With query → FTS5 MATCH, sorted by FTS5's bm25() with a recency tie-
 *    breaker (newer first).
 *
 * Side effect: bumps `last_referenced_at` for returned rows so weak /
 * unused facts can be retired by future consolidation.
 */
export function queryFacts(opts: QueryOpts): QueryResult {
  const db = helper.get()
  if (!db) return { facts: [], matched: 0 }
  const k = Math.min(Math.max(opts.k ?? 5, 1), 50)
  const cat = opts.category
  const q = (opts.query || '').trim()
  try {
    let rows: Fact[]
    if (!q) {
      rows = db.prepare(`
        SELECT * FROM facts
        WHERE user_key = ? ${cat ? 'AND category = ?' : ''}
        ORDER BY created_at DESC LIMIT ?
      `).all(...(cat ? [opts.user_key, cat, k] : [opts.user_key, k])) as Fact[]
    } else {
      const safeQ = buildFtsMatch(q)
      if (!safeQ) return { facts: [], matched: 0 }
      rows = db.prepare(`
        SELECT f.* FROM facts_fts t
        JOIN facts f ON f.id = t.rowid
        WHERE t.user_key = ? AND facts_fts MATCH ?
        ${cat ? 'AND f.category = ?' : ''}
        ORDER BY bm25(facts_fts), f.created_at DESC
        LIMIT ?
      `).all(...(cat
        ? [opts.user_key, safeQ, cat, k]
        : [opts.user_key, safeQ, k * 3])) as Fact[]  // pull 3x for RRF headroom
    }
    // Bump last_referenced_at for everything we returned.
    if (rows.length > 0) {
      const ts = nowSec()
      const stmt = db.prepare('UPDATE facts SET last_referenced_at = ? WHERE id = ?')
      for (const r of rows) { try { stmt.run(ts, r.id) } catch { /* ignore */ } }
    }
    return { facts: rows.slice(0, k), matched: rows.length }
  } catch (err) {
    log.warn({ event: 'memory.query_failed', err: String(err), q })
    return { facts: [], matched: 0 }
  }
}

/**
 * v1.6 — async hybrid retrieval. When a vector backend is ready, run FTS5
 * + vector top-K in parallel, fuse with reciprocal-rank-fusion, and return
 * the merged top-K. Falls back to plain queryFacts when backend is off or
 * the embedding model isn't loaded.
 *
 * Use this from memory-rpc.handleMemoryOp('query') so MCP callers get
 * better recall automatically without changing the call site.
 */
export async function queryFactsHybrid(opts: QueryOpts): Promise<QueryResult> {
  const k = Math.min(Math.max(opts.k ?? 5, 1), 50)
  const q = (opts.query || '').trim()
  if (!q) return queryFacts(opts)
  let backend: import('./memory-vector.js').EmbeddingBackend
  try {
    backend = (await import('./memory-vector.js')).getActiveBackend()
  } catch {
    return queryFacts(opts)
  }
  if (!backend.ready) return queryFacts(opts)

  // FTS5 candidates first (synchronous, fast).
  const ftsResult = queryFacts({ ...opts, k: Math.min(k * 3, 30) })
  // Vector candidates next (async, may time out).
  let vecResult: Fact[] = []
  try {
    const { cosineSim, bufferToFloat32, getHybridWeight } = await import('./memory-vector.js')
    void getHybridWeight  // (currently fixed weight in RRF; reserved for future tuning)
    const queryVecArr = await backend.embed([q])
    const queryVec = queryVecArr[0]
    if (queryVec && queryVec.length > 0) {
      const db = helper.get()
      if (db) {
        // Pull candidates that match the ACTIVE backend's model + dims.
        // Mixing embeddings from different models in one cosine ranking
        // produces garbage similarities (different vector spaces).
        const expectedModel = `${backend.name}:${backend.modelId}`
        const candidates = db.prepare(`
          SELECT * FROM facts
          WHERE user_key = ?
            AND embedding IS NOT NULL
            AND embedding_dims = ?
            AND embedding_model = ?
            ${opts.category ? 'AND category = ?' : ''}
        `).all(...(opts.category
          ? [opts.user_key, queryVec.length, expectedModel, opts.category]
          : [opts.user_key, queryVec.length, expectedModel])) as Array<Fact & { embedding: Buffer }>
        const scored = candidates.map((row) => ({
          row, score: cosineSim(queryVec, bufferToFloat32(row.embedding)),
        }))
        scored.sort((a, b) => b.score - a.score)
        vecResult = scored.slice(0, k * 3).map((s) => s.row)
      }
    }
  } catch (err) {
    log.debug({ event: 'memory.hybrid.vector_leg_failed', err: String(err) })
  }

  // RRF fusion. k_const=60 is the standard RRF damping.
  const RRF_K = 60
  const scores = new Map<number, number>()
  const idToFact = new Map<number, Fact>()
  ftsResult.facts.forEach((f, i) => {
    scores.set(f.id, (scores.get(f.id) || 0) + 1 / (RRF_K + i + 1))
    idToFact.set(f.id, f)
  })
  vecResult.forEach((f, i) => {
    scores.set(f.id, (scores.get(f.id) || 0) + 1 / (RRF_K + i + 1))
    idToFact.set(f.id, f)
  })
  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => idToFact.get(id)!)
    .filter(Boolean)

  // Bump last_referenced_at for the merged result set.
  const db = helper.get()
  if (db && ranked.length > 0) {
    const ts = nowSec()
    const stmt = db.prepare('UPDATE facts SET last_referenced_at = ? WHERE id = ?')
    for (const r of ranked) { try { stmt.run(ts, r.id) } catch { /* ignore */ } }
  }
  return { facts: ranked, matched: ranked.length }
}

/** v1.6 — backfill embeddings for facts that don't have one (e.g. existed
 *  before vector backend was enabled). Returns counts; safe to call again.
 *  Stops early on backend errors (returns partial). */
export async function backfillEmbeddings(opts: {
  user_key?: string  // omit to backfill all users
  batchSize?: number
  maxRows?: number
}): Promise<{ processed: number; succeeded: number; failed: number; errored?: string }> {
  const db = helper.get()
  if (!db) return { processed: 0, succeeded: 0, failed: 0, errored: 'db unavailable' }
  let backend: import('./memory-vector.js').EmbeddingBackend
  try {
    backend = (await import('./memory-vector.js')).getActiveBackend()
  } catch (err) {
    return { processed: 0, succeeded: 0, failed: 0, errored: String(err) }
  }
  if (!backend.ready) return { processed: 0, succeeded: 0, failed: 0, errored: 'backend not ready' }
  const { float32ToBuffer, getBatchSize } = await import('./memory-vector.js')
  const batchSize = opts.batchSize ?? getBatchSize()
  const maxRows = opts.maxRows ?? 5000

  const where = opts.user_key
    ? 'WHERE user_key = ? AND (embedding IS NULL OR embedding_model != ?)'
    : 'WHERE embedding IS NULL OR embedding_model != ?'
  const expectedModel = `${backend.name}:${backend.modelId}`
  const selectParams: unknown[] = opts.user_key
    ? [opts.user_key, expectedModel]
    : [expectedModel]

  const rows = db.prepare(`
    SELECT id, user_key, what, who, when_text, where_label, why FROM facts
    ${where} LIMIT ?
  `).all(...selectParams, maxRows) as Array<{
    id: number; user_key: string; what: string; who: string;
    when_text: string; where_label: string; why: string;
  }>

  let processed = 0, succeeded = 0, failed = 0
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const texts = batch.map((r) => indexableText(r))
    let vecs: Float32Array[] = []
    try {
      vecs = await backend.embed(texts)
    } catch (err) {
      log.warn({ event: 'memory.backfill.batch_failed', err: String(err) })
      failed += batch.length
      processed += batch.length
      continue
    }
    const ts = nowSec()
    const stmt = db.prepare(`
      UPDATE facts SET embedding = ?, embedding_model = ?, embedding_dims = ?, embedded_at = ?
      WHERE id = ?
    `)
    for (let j = 0; j < batch.length; j++) {
      const v = vecs[j]
      if (!v || v.length === 0) { failed++; processed++; continue }
      try {
        stmt.run(float32ToBuffer(v), expectedModel, v.length, ts, batch[j].id)
        succeeded++
      } catch (err) {
        log.debug({ event: 'memory.backfill.write_failed', id: batch[j].id, err: String(err) })
        failed++
      }
      processed++
    }
    // Yield between batches so we don't hog the event loop on large backfills.
    await new Promise((r) => setImmediate(r))
  }
  return { processed, succeeded, failed }
}

export interface VectorCoverage {
  total: number
  withEmbedding: number
  withDifferentModel: number
}
export function getVectorCoverage(user_key?: string): VectorCoverage {
  const db = helper.get()
  if (!db) return { total: 0, withEmbedding: 0, withDifferentModel: 0 }
  try {
    const where = user_key ? 'WHERE user_key = ?' : ''
    const params: unknown[] = user_key ? [user_key] : []
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM facts ${where}`).get(...params) as { n: number }).n
    const withEmb = (db.prepare(`SELECT COUNT(*) AS n FROM facts ${where} ${where ? 'AND' : 'WHERE'} embedding IS NOT NULL`).get(...params) as { n: number }).n
    return { total, withEmbedding: withEmb, withDifferentModel: 0 }
  } catch {
    return { total: 0, withEmbedding: 0, withDifferentModel: 0 }
  }
}

/** Clear all embedding fields for a user (or all). Useful when switching
 *  backends — embeddings from different models can't be compared. */
export function clearEmbeddings(user_key?: string): number {
  const db = helper.get()
  if (!db) return 0
  try {
    const where = user_key ? 'WHERE user_key = ?' : ''
    const params: unknown[] = user_key ? [user_key] : []
    const r = db.prepare(`
      UPDATE facts SET embedding = NULL, embedding_model = NULL, embedding_dims = NULL, embedded_at = NULL
      ${where}
    `).run(...params)
    return r.changes
  } catch (err) {
    log.warn({ event: 'memory.clear_embeddings_failed', err: String(err) })
    return 0
  }
}

export function listRecentFacts(user_key: string, limit: number = 50): Fact[] {
  const db = helper.get()
  if (!db) return []
  try {
    return db.prepare(`
      SELECT * FROM facts WHERE user_key = ? ORDER BY created_at DESC LIMIT ?
    `).all(user_key, Math.min(Math.max(limit, 1), 500)) as Fact[]
  } catch {
    return []
  }
}

export function countFacts(user_key: string): number {
  const db = helper.get()
  if (!db) return 0
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM facts WHERE user_key = ?').get(user_key) as { n: number }
    return r.n
  } catch { return 0 }
}

// ─── Persona profile ─────────────────────────────────────────────────

export interface PersonaProfile {
  user_key: string
  summary: string
  updated_at: number
}

export function getPersona(user_key: string): PersonaProfile | null {
  const db = helper.get()
  if (!db) return null
  try {
    return (db.prepare('SELECT * FROM persona_profile WHERE user_key = ?')
      .get(user_key) as PersonaProfile | undefined) ?? null
  } catch { return null }
}

export function upsertPersona(user_key: string, summary: string): boolean {
  const db = helper.get()
  if (!db) return false
  try {
    db.prepare(`
      INSERT INTO persona_profile (user_key, summary, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_key) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
    `).run(user_key, summary, nowSec())
    return true
  } catch (err) {
    log.warn({ event: 'memory.persona_upsert_failed', err: String(err) })
    return false
  }
}

// ─── Web admin helpers (v1.5 follow-up) ──────────────────────────────

export interface UserSummary {
  user_key: string
  fact_count: number
  oldest_fact_at: number | null
  newest_fact_at: number | null
  has_persona: boolean
  persona_updated_at: number | null
}

/** Enumerate every user_key the memory system has touched, with quick stats.
 *  Used by /api/memory/users to populate the admin selector. */
export function listUsers(): UserSummary[] {
  const db = helper.get()
  if (!db) return []
  try {
    const factsRows = db.prepare(`
      SELECT
        user_key,
        COUNT(*) AS fact_count,
        MIN(created_at) AS oldest_fact_at,
        MAX(created_at) AS newest_fact_at
      FROM facts GROUP BY user_key
    `).all() as Array<{ user_key: string; fact_count: number; oldest_fact_at: number; newest_fact_at: number }>
    const personaRows = db.prepare('SELECT user_key, updated_at FROM persona_profile').all() as Array<{ user_key: string; updated_at: number }>
    const personaMap = new Map(personaRows.map((p) => [p.user_key, p.updated_at]))
    const out: UserSummary[] = []
    const seen = new Set<string>()
    for (const f of factsRows) {
      seen.add(f.user_key)
      out.push({
        user_key: f.user_key,
        fact_count: f.fact_count,
        oldest_fact_at: f.oldest_fact_at,
        newest_fact_at: f.newest_fact_at,
        has_persona: personaMap.has(f.user_key),
        persona_updated_at: personaMap.get(f.user_key) ?? null,
      })
    }
    // Users with a persona but no facts (rare — manual upsertPersona)
    for (const p of personaRows) {
      if (seen.has(p.user_key)) continue
      out.push({
        user_key: p.user_key,
        fact_count: 0,
        oldest_fact_at: null,
        newest_fact_at: null,
        has_persona: true,
        persona_updated_at: p.updated_at,
      })
    }
    out.sort((a, b) => (b.newest_fact_at ?? 0) - (a.newest_fact_at ?? 0))
    return out
  } catch (err) {
    log.warn({ event: 'memory.list_users_failed', err: String(err) })
    return []
  }
}

export interface FactPage {
  total: number
  limit: number
  offset: number
  facts: Fact[]
}

/** Paged fact listing with optional filters. Mirrors queryFacts but adds
 *  offset + total count for table pagination. */
export function listFacts(opts: {
  user_key: string
  query?: string
  category?: FactCategory
  limit?: number
  offset?: number
}): FactPage {
  const db = helper.get()
  if (!db) return { total: 0, limit: 0, offset: 0, facts: [] }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const cat = opts.category
  const q = (opts.query || '').trim()
  try {
    let totalSql: string
    let totalParams: unknown[]
    let rowsSql: string
    let rowsParams: unknown[]
    if (!q) {
      totalSql = `SELECT COUNT(*) AS n FROM facts WHERE user_key = ? ${cat ? 'AND category = ?' : ''}`
      totalParams = cat ? [opts.user_key, cat] : [opts.user_key]
      rowsSql = `SELECT * FROM facts WHERE user_key = ? ${cat ? 'AND category = ?' : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      rowsParams = cat ? [opts.user_key, cat, limit, offset] : [opts.user_key, limit, offset]
    } else {
      const safeQ = buildFtsMatch(q)
      if (!safeQ) return { total: 0, limit, offset, facts: [] }
      totalSql = `
        SELECT COUNT(*) AS n FROM facts_fts t JOIN facts f ON f.id = t.rowid
        WHERE t.user_key = ? AND facts_fts MATCH ? ${cat ? 'AND f.category = ?' : ''}
      `
      totalParams = cat ? [opts.user_key, safeQ, cat] : [opts.user_key, safeQ]
      rowsSql = `
        SELECT f.* FROM facts_fts t JOIN facts f ON f.id = t.rowid
        WHERE t.user_key = ? AND facts_fts MATCH ? ${cat ? 'AND f.category = ?' : ''}
        ORDER BY bm25(facts_fts), f.created_at DESC LIMIT ? OFFSET ?
      `
      rowsParams = cat ? [opts.user_key, safeQ, cat, limit, offset] : [opts.user_key, safeQ, limit, offset]
    }
    const total = (db.prepare(totalSql).get(...totalParams) as { n: number }).n
    const facts = db.prepare(rowsSql).all(...rowsParams) as Fact[]
    return { total, limit, offset, facts }
  } catch (err) {
    log.warn({ event: 'memory.list_facts_failed', err: String(err) })
    return { total: 0, limit, offset, facts: [] }
  }
}

/** Bulk delete by user + optional filters. Returns row count actually deleted.
 *  Defaults are intentionally inert ({user_key} alone deletes ALL facts for
 *  that user) — caller must explicitly opt in to clear-all by passing
 *  confirm_clear: true. Otherwise needs at least one filter. */
export function bulkDeleteFacts(opts: {
  user_key: string
  ids?: number[]
  category?: FactCategory
  max_confidence?: number  // delete facts with confidence <= this
  confirm_clear?: boolean
}): number {
  const db = helper.get()
  if (!db) return 0
  const filters: string[] = ['user_key = ?']
  const params: unknown[] = [opts.user_key]
  if (opts.ids && opts.ids.length > 0) {
    const placeholders = opts.ids.map(() => '?').join(',')
    filters.push(`id IN (${placeholders})`)
    params.push(...opts.ids)
  }
  if (opts.category) { filters.push('category = ?'); params.push(opts.category) }
  if (typeof opts.max_confidence === 'number') {
    filters.push('confidence <= ?')
    params.push(opts.max_confidence)
  }
  // Safety: if no filter beyond user_key, require explicit clear flag.
  if (filters.length === 1 && !opts.confirm_clear) {
    log.warn({ event: 'memory.bulk_delete.refused_unfiltered', user_key: opts.user_key })
    return 0
  }
  const where = filters.join(' AND ')
  try {
    // Need ids + indexed text for each — facts_fts is contentless so we
    // must drive its index via the per-row `INSERT(..., 'delete', ...)`
    // command rather than a single SQL DELETE. The 5W1H columns let us
    // reconstruct the text saveFact originally indexed.
    type FtsRow = {
      id: number
      user_key: string
      what: string
      who: string | null
      when_text: string | null
      where_label: string | null
      why: string | null
    }
    const targets = db
      .prepare(`SELECT id, user_key, what, who, when_text, where_label, why FROM facts WHERE ${where}`)
      .all(...params) as FtsRow[]
    if (targets.length === 0) return 0
    const ftsDel = db.prepare(
      "INSERT INTO facts_fts(facts_fts, rowid, user_key, text) VALUES ('delete', ?, ?, ?)",
    )
    for (const t of targets) {
      const text = indexableText({
        user_key: t.user_key,
        what: t.what,
        who: t.who ?? '',
        when_text: t.when_text ?? '',
        where_label: t.where_label ?? '',
        why: t.why ?? '',
      })
      ftsDel.run(t.id, t.user_key, text)
    }
    const ids = targets.map((t) => t.id)
    const idPlaceholders = ids.map(() => '?').join(',')
    const r = db.prepare(`DELETE FROM facts WHERE id IN (${idPlaceholders})`).run(...ids)
    return r.changes
  } catch (err) {
    log.warn({ event: 'memory.bulk_delete_failed', err: String(err) })
    return 0
  }
}

export function deletePersona(user_key: string): boolean {
  const db = helper.get()
  if (!db) return false
  try {
    const r = db.prepare('DELETE FROM persona_profile WHERE user_key = ?').run(user_key)
    return r.changes > 0
  } catch (err) {
    log.warn({ event: 'memory.persona_delete_failed', err: String(err) })
    return false
  }
}

/** Full export: persona + all facts for one user, JSON-safe shape. */
export function exportUserMemory(user_key: string): {
  user_key: string
  persona: PersonaProfile | null
  facts: Fact[]
  exported_at: string
} {
  return {
    user_key,
    persona: getPersona(user_key),
    facts: listRecentFacts(user_key, 10000),
    exported_at: new Date().toISOString(),
  }
}

// ─── Retention sweep (R12 ②) ────────────────────────────────────────
//
// LRU TTL: `last_referenced_at` is bumped by queryFacts /
// queryFactsHybrid, so a fact that's been recalled within the window
// survives even if its `created_at` is old. This intentionally
// preserves high-value facts (e.g. operator's name, billing project)
// while letting one-shot facts drop off.
//
// Persona uses `updated_at` (set by upsertPersona via distillation).
//
// `pruneExpired*Internal(db)` accept an explicit Database handle so
// they can be called from the helper init callback (where helper.get()
// would re-enter). Public wrappers call helper.get() the usual way.

function pruneExpiredFactsInternal(db: import('better-sqlite3').Database): number {
  const days = resolveFactRetentionDays()
  if (days <= 0) return 0
  const cutoff = nowSec() - days * 86400
  // Need 5W1H columns to feed facts_fts reverse-delete (contentless FTS).
  const candidates = db.prepare(`
    SELECT id, user_key, what, who, when_text, where_label, why
    FROM facts WHERE last_referenced_at < ?
  `).all(cutoff) as Array<{
    id: number; user_key: string; what: string;
    who: string | null; when_text: string | null;
    where_label: string | null; why: string | null;
  }>
  if (candidates.length === 0) return 0
  const deleted = db.transaction((): number => {
    const ftsDel = db.prepare(
      "INSERT INTO facts_fts(facts_fts, rowid, user_key, text) VALUES ('delete', ?, ?, ?)",
    )
    for (const c of candidates) {
      const text = indexableText({
        user_key: c.user_key,
        what: c.what,
        who: c.who ?? '',
        when_text: c.when_text ?? '',
        where_label: c.where_label ?? '',
        why: c.why ?? '',
      })
      try { ftsDel.run(c.id, c.user_key, text) } catch { /* contentless FTS rebuild quirk; row delete is what matters */ }
    }
    const ids = candidates.map((c) => c.id)
    const placeholders = ids.map(() => '?').join(',')
    return db.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...ids).changes
  })()
  if (deleted > 0) {
    log.info({ event: 'memory.pruned_facts', deleted, days }, `Pruned ${deleted} fact(s) older than ${days}d`)
  }
  return deleted
}

function pruneExpiredPersonaInternal(db: import('better-sqlite3').Database): number {
  const days = resolvePersonaRetentionDays()
  if (days <= 0) return 0
  const cutoff = nowSec() - days * 86400
  const r = db.prepare('DELETE FROM persona_profile WHERE updated_at < ?').run(cutoff)
  if (r.changes > 0) {
    log.info({ event: 'memory.pruned_persona', deleted: r.changes, days })
  }
  return r.changes
}

/** Public retention API — useful for /api/memory/prune endpoint + tests. */
export function pruneExpiredFacts(): number {
  const db = helper.get()
  if (!db) return 0
  try { return pruneExpiredFactsInternal(db) } catch (err) {
    log.warn({ event: 'memory.prune_facts_failed', err: String(err) })
    return 0
  }
}
export function pruneExpiredPersona(): number {
  const db = helper.get()
  if (!db) return 0
  try { return pruneExpiredPersonaInternal(db) } catch (err) {
    log.warn({ event: 'memory.prune_persona_failed', err: String(err) })
    return 0
  }
}

/** Stop the periodic retention sweep (tests + graceful shutdown). */
export function stopMemoryRetentionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

export function closeMemoryDb(): void {
  stopMemoryRetentionSweep()
  helper.close()
}

export const MEMORY_DB_PATH = MEMORY_DB
