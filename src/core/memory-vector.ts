// memory-vector — embedding backend abstraction for the long-term memory
// hybrid retrieval pipeline.
//
// Three backends, all behind one tiny interface:
//
//   OffBackend       — default. `ready=false`, every call no-ops. Zero
//                      import cost; @xenova/transformers stays unloaded.
//   LocalBgeBackend  — lazy-loads @xenova/transformers + a Hugging Face
//                      model (default Xenova/bge-base-zh-v1.5). First use
//                      triggers a ~250MB CDN download; afterwards stays in
//                      memory + CPU inference (~50ms/batch).
//   OpenAIBackend    — POSTs to {baseUrl}/embeddings; compatible with any
//                      OpenAI-format service (Azure, Ollama, 智谱, etc).
//                      All requests wrapped in AbortSignal.timeout to never
//                      block the page when the network is bad.
//
// The active backend is selected by IMHUB_MEMORY_VECTOR_BACKEND
// (off | local | openai). Status / download / test endpoints in
// web/server.ts read from `getActiveBackend()` to drive the UI.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger as rootLogger } from './logger.js'
import { AGIM_HOME } from './agim-paths.js'

const log = rootLogger.child({ component: 'memory-vector' })

const HTTP_TIMEOUT_MS = 10_000
const BATCH_TIMEOUT_MS = 30_000

export type BackendName = 'off' | 'local' | 'openai'

export interface EmbeddingBackend {
  readonly name: BackendName
  readonly ready: boolean
  readonly dims: number
  readonly modelId: string
  /** Generate embeddings for a batch of texts. Returns same-length array. */
  embed(texts: string[]): Promise<Float32Array[]>
  /** Describe current state for the status endpoint. */
  describe(): BackendStatus
}

export interface BackendStatus {
  backend: BackendName
  ready: boolean
  dims: number
  modelId: string
  lastError: string | null
  /** Local-only: model files present on disk. ready may still be false if
   *  the in-process pipeline hasn't loaded them yet (post-restart warmup). */
  downloaded?: boolean
  /** Backend-specific extra info (model file size, baseUrl, etc.) */
  detail: Record<string, unknown>
}

// ─── OffBackend ──────────────────────────────────────────────────────

class OffBackend implements EmbeddingBackend {
  readonly name: BackendName = 'off'
  readonly ready = false
  readonly dims = 0
  readonly modelId = ''
  async embed(): Promise<Float32Array[]> { return [] }
  describe(): BackendStatus {
    return {
      backend: 'off', ready: false, dims: 0, modelId: '',
      lastError: null,
      detail: { hint: 'set IMHUB_MEMORY_VECTOR_BACKEND=local|openai to enable' },
    }
  }
}

// ─── LocalBgeBackend ─────────────────────────────────────────────────

interface DownloadProgress {
  phase: 'idle' | 'downloading' | 'ready' | 'failed'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

class LocalBgeBackend implements EmbeddingBackend {
  readonly name: BackendName = 'local'
  modelId: string
  dims = 0
  // populated after first successful pipeline load
  private extractor: ((text: string | string[], opts: unknown) => Promise<unknown>) | null = null
  private loadPromise: Promise<void> | null = null
  private lastError: string | null = null
  // Per-process download progress (UI polls /api/memory/vector/status).
  private progress: DownloadProgress = {
    phase: 'idle', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0,
    startedAt: null, finishedAt: null, error: null,
  }

  constructor(modelId: string) {
    this.modelId = modelId
    // Auto-warm: if the model is already on disk from a previous run,
    // load it in the background so `ready` flips to true within seconds.
    // Without this, the backend stays "not ready" after every restart
    // until the user clicks 📥 download / 🧪 test, AND saveFact silently
    // skips embedding writes in the meantime.
    if (this.isDownloaded()) {
      void this.ensureReady().catch((err) => {
        log.warn({
          event: 'vector.local.autowarm_failed', modelId: this.modelId,
          err: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  /** Cheap check: are model files on disk? Used to flip the UI's
   *  "downloaded but loading" hint and to gate auto-warm. */
  isDownloaded(): boolean {
    try {
      const onnx = join(AGIM_HOME, 'cache', 'transformers', this.modelId, 'onnx', 'model_quantized.onnx')
      return existsSync(onnx)
    } catch { return false }
  }

  get ready(): boolean {
    return this.extractor !== null && this.dims > 0
  }

  /**
   * Idempotent: returns the same promise on concurrent calls. Triggers the
   * @xenova/transformers dynamic import + model download (CDN) + pipeline
   * load. UI calls /api/memory/vector/download which calls this with
   * forceDownload=true on the very first run.
   */
  async ensureReady(): Promise<void> {
    if (this.ready) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this._load().catch((err) => {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.progress.phase = 'failed'
      this.progress.error = this.lastError
      this.progress.finishedAt = Date.now()
      // Reset so a follow-up download attempt can retry.
      this.loadPromise = null
      throw err
    })
    return this.loadPromise
  }

  private async _load(): Promise<void> {
    log.info({ event: 'vector.local.load_start', modelId: this.modelId })
    this.progress.phase = 'downloading'
    this.progress.startedAt = Date.now()
    this.progress.error = null

    // Dynamic import so the runtime cost is only paid when the backend is on.
    // @xenova/transformers is in optionalDependencies (skipped on CI install
    // to avoid a large ONNX postinstall hang); ts-ignore needed so tsc
    // doesn't error when the module isn't on disk at build time.
    // @ts-ignore -- optional dep, may not be installed at build time
    const tf = await import('@xenova/transformers') as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>
      env: { allowLocalModels: boolean; cacheDir?: string }
    }
    // Cache to ~/.agim/cache/transformers so we don't sprinkle files all
    // over $HOME. allowLocalModels stays default (true) — cached models
    // load offline after first download.
    try {
      tf.env.cacheDir = join(AGIM_HOME, 'cache', 'transformers')
    } catch (e) {
      log.debug({ event: 'vector.local.cachedir_set_failed', err: String(e) })
    }

    // progress_callback fires for each file: { status, name, file, loaded, total, progress }
    const progressCallback = (info: Record<string, unknown>): void => {
      try {
        if (info.status === 'progress') {
          this.progress.bytesTotal = Math.max(this.progress.bytesTotal, Number(info.total) || 0)
          this.progress.bytesDone = Number(info.loaded) || this.progress.bytesDone
        } else if (info.status === 'done') {
          this.progress.filesDone += 1
        } else if (info.status === 'initiate') {
          this.progress.filesTotal += 1
        }
      } catch { /* noop */ }
    }
    const extractor = await tf.pipeline('feature-extraction', this.modelId, {
      quantized: true,
      progress_callback: progressCallback,
    }) as (text: string | string[], opts: unknown) => Promise<unknown>

    // Probe dims with a 1-char input.
    const probeOutput = await extractor('hi', { pooling: 'mean', normalize: true }) as { data: Float32Array; dims?: number[] }
    const data = probeOutput.data
    if (!data || data.length === 0) throw new Error('embedding model returned empty output')
    this.dims = data.length
    this.extractor = extractor
    this.progress.phase = 'ready'
    this.progress.finishedAt = Date.now()
    log.info({ event: 'vector.local.ready', dims: this.dims, modelId: this.modelId })
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready) {
      // Don't auto-trigger download from embed() — user has to opt in via
      // /api/memory/vector/download. Silent no-op keeps writes fast.
      return texts.map(() => new Float32Array(0))
    }
    const out: Float32Array[] = []
    for (const t of texts) {
      const trimmed = t.length > 4000 ? t.slice(0, 4000) : t
      const result = await this.extractor!(trimmed, { pooling: 'mean', normalize: true }) as { data: Float32Array }
      out.push(new Float32Array(result.data))
    }
    return out
  }

  getProgress(): DownloadProgress { return { ...this.progress } }

  describe(): BackendStatus {
    return {
      backend: 'local', ready: this.ready, dims: this.dims,
      modelId: this.modelId,
      lastError: this.lastError,
      downloaded: this.isDownloaded(),
      detail: { progress: this.getProgress() },
    }
  }
}

// ─── OpenAIBackend ───────────────────────────────────────────────────

class OpenAIBackend implements EmbeddingBackend {
  readonly name: BackendName = 'openai'
  readonly modelId: string
  readonly baseUrl: string
  readonly apiKey: string
  dims = 0  // probed on first successful embed; 0 until then
  ready = false  // becomes true after first successful embed (key + URL work)
  private lastError: string | null = null

  constructor(baseUrl: string, modelId: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.modelId = modelId
    this.apiKey = apiKey
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.apiKey) {
      this.lastError = 'API key not configured'
      return texts.map(() => new Float32Array(0))
    }
    if (texts.length === 0) return []
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), BATCH_TIMEOUT_MS)
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.modelId, input: texts }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t))
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      const json = await res.json() as { data: Array<{ embedding: number[] }> }
      if (!Array.isArray(json.data)) throw new Error('response missing data[]')
      const out = json.data.map((d) => new Float32Array(d.embedding))
      if (out.length > 0 && out[0].length > 0) {
        this.dims = out[0].length
        this.ready = true
        this.lastError = null
      }
      return out
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.ready = false
      log.warn({ event: 'vector.openai.embed_failed', err: this.lastError })
      return texts.map(() => new Float32Array(0))
    }
  }

  /** Lightweight probe used by /api/memory/vector/test. */
  async test(): Promise<{ ok: boolean; dims?: number; latencyMs?: number; error?: string }> {
    const start = Date.now()
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.modelId, input: ['ping'] }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t))
      const latencyMs = Date.now() - start
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}`, latencyMs }
      }
      const json = await res.json() as { data?: Array<{ embedding?: number[] }> }
      const emb = json.data?.[0]?.embedding
      if (!Array.isArray(emb)) return { ok: false, error: 'response missing embedding', latencyMs }
      this.dims = emb.length
      this.ready = true
      this.lastError = null
      return { ok: true, dims: emb.length, latencyMs }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isTimeout = /aborted|timeout/i.test(msg)
      return { ok: false, error: isTimeout ? `timed out after ${HTTP_TIMEOUT_MS}ms` : msg, latencyMs: Date.now() - start }
    }
  }

  describe(): BackendStatus {
    return {
      backend: 'openai', ready: this.ready, dims: this.dims,
      modelId: this.modelId, lastError: this.lastError,
      detail: { baseUrl: this.baseUrl, hasKey: !!this.apiKey },
    }
  }
}

// ─── factory + singletons ────────────────────────────────────────────

const off = new OffBackend()
let localSingleton: LocalBgeBackend | null = null
let openaiSingleton: OpenAIBackend | null = null

function readBackendName(): BackendName {
  const v = (process.env.IMHUB_MEMORY_VECTOR_BACKEND || 'off').toLowerCase()
  return v === 'local' || v === 'openai' ? v : 'off'
}

export function getActiveBackend(): EmbeddingBackend {
  const which = readBackendName()
  if (which === 'off') return off
  if (which === 'local') {
    const modelId = process.env.IMHUB_MEMORY_VECTOR_LOCAL_MODEL || 'Xenova/bge-base-zh-v1.5'
    if (!localSingleton || localSingleton.modelId !== modelId) {
      localSingleton = new LocalBgeBackend(modelId)
    }
    return localSingleton
  }
  // openai
  const baseUrl = process.env.IMHUB_MEMORY_VECTOR_OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const modelId = process.env.IMHUB_MEMORY_VECTOR_OPENAI_MODEL || 'text-embedding-3-small'
  const apiKey = process.env.IMHUB_MEMORY_VECTOR_OPENAI_API_KEY || ''
  if (!openaiSingleton
      || openaiSingleton.baseUrl !== baseUrl.replace(/\/$/, '')
      || openaiSingleton.modelId !== modelId
      || openaiSingleton.apiKey !== apiKey) {
    openaiSingleton = new OpenAIBackend(baseUrl, modelId, apiKey)
  }
  return openaiSingleton
}

/** Reset all backend singletons. Used by tests + when env changes via /api/env. */
export function _resetVectorBackendsForTests(): void {
  localSingleton = null
  openaiSingleton = null
}

export function getHybridWeight(): number {
  const raw = parseFloat(process.env.IMHUB_MEMORY_VECTOR_HYBRID_WEIGHT || '0.5')
  if (!Number.isFinite(raw)) return 0.5
  return Math.max(0, Math.min(1, raw))
}

export function getBatchSize(): number {
  const raw = parseInt(process.env.IMHUB_MEMORY_VECTOR_BATCH_SIZE || '32', 10)
  if (!Number.isFinite(raw) || raw < 1) return 32
  return Math.min(raw, 128)
}

// ─── helpers exposed for memory.ts + endpoints ───────────────────────

/** Triggers local-backend download. No-op for off / openai. */
export async function triggerLocalDownload(): Promise<{ ok: boolean; error?: string }> {
  const b = getActiveBackend()
  if (b.name !== 'local') return { ok: false, error: `backend is ${b.name}, not local` }
  try {
    await (b as LocalBgeBackend).ensureReady()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Calls test() for openai; ensureReady() for local. */
export async function testActiveBackend(): Promise<{ ok: boolean; dims?: number; latencyMs?: number; error?: string }> {
  const b = getActiveBackend()
  if (b.name === 'off') return { ok: false, error: 'backend is off' }
  if (b.name === 'openai') return (b as OpenAIBackend).test()
  // local
  try {
    const start = Date.now()
    await (b as LocalBgeBackend).ensureReady()
    const vec = await b.embed(['ping'])
    const latencyMs = Date.now() - start
    if (vec[0]?.length > 0) return { ok: true, dims: vec[0].length, latencyMs }
    return { ok: false, error: 'embed returned empty vector', latencyMs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Float32Array <-> Buffer round-trip helpers for SQLite BLOB columns. */
export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}
export function bufferToFloat32(buf: Buffer): Float32Array {
  // Float32Array requires the underlying ArrayBuffer offset to be 4-byte
  // aligned. better-sqlite3 returns BLOBs from a shared pool with arbitrary
  // byteOffset, so we copy into a fresh ArrayBuffer first.
  const copy = new ArrayBuffer(buf.byteLength)
  new Uint8Array(copy).set(buf)
  return new Float32Array(copy)
}

/** Cosine similarity for two normalized (unit-length) Float32Arrays.
 *  All our backends normalize by default; this is just a dot product. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
