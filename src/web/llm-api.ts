// llm-api — web REST surface for the Stage 4 LLM-backend configuration
// UX. Mirrors what `agim setup llm` does on the CLI side, but lives
// behind the existing web auth model (operators only — gated by
// requireAdmin in the caller).
//
// Endpoints exposed:
//
//   GET    /api/llm                      → { backends, roles, status }
//   POST   /api/llm/backends             body { name, provider, baseUrl, model, apiKey }
//                                        → 201 Created or 409 Conflict / 400 Validation
//   DELETE /api/llm/backends/:name       → 200 OK { removedRoles }
//   PUT    /api/llm/roles                body { cheap?, evaluator?, "native-chat"?, … }
//                                        → 200 OK; empty string / null deletes the binding
//   POST   /api/llm/secrets/:name        body { apiKey }   → 200 OK
//   DELETE /api/llm/secrets/:name        → 200 OK
//
// All write paths run the merged config through configSchema BEFORE
// touching disk so a typo can't poison ~/.agim/config.json — same
// safety net as the CLI wizard.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { configSchema } from '../core/config-schema.js'
import { readConfigObject, updateConfigObject } from '../core/config-store.js'
import {
  saveSecret, removeSecret, describeSecretSource,
} from '../core/llm/secrets.js'
import { clearAgentCache } from '../core/onboarding.js'
import { getProviderByName, loadFromConfig as loadLlmFromConfig } from '../core/llm/registry.js'

interface RawBackend {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  apiKeyEnv?: string
  costPer1kIn?: number
  costPer1kOut?: number
  maxRetries?: number
  timeoutMs?: number
}

interface RawConfig {
  llmBackends?: RawBackend[]
  llmRoles?: Record<string, string>
  [k: string]: unknown
}

class LlmConfigError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: string[]) {
    super(message)
    this.name = 'LlmConfigError'
  }
}

// ─── HTTP helpers (deliberately tiny — server.ts has its own JSON
//      helpers; we copy the shape here to keep this module standalone) ─

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw.trim()) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// ─── routing ────────────────────────────────────────────────────────

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served (caller should stop walking its own route table); `false`
 * when the URL/method didn't match anything in this module.
 */
export async function handleLlmApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/llm' && m === 'GET') {
    await handleList(res); return true
  }
  if (p === '/api/llm/backends' && m === 'POST') {
    await handleAddBackend(req, res); return true
  }
  if (p === '/api/llm/roles' && m === 'PUT') {
    await handlePutRoles(req, res); return true
  }
  const rmBackend = p.match(/^\/api\/llm\/backends\/([A-Za-z0-9-]+)$/)
  if (rmBackend && m === 'DELETE') {
    await handleRemoveBackend(res, rmBackend[1]); return true
  }
  const setSecret = p.match(/^\/api\/llm\/secrets\/([A-Za-z0-9-]+)$/)
  if (setSecret && m === 'POST') {
    await handleSetSecret(req, res, setSecret[1]); return true
  }
  if (setSecret && m === 'DELETE') {
    await handleRemoveSecret(res, setSecret[1]); return true
  }
  const pingBackend = p.match(/^\/api\/llm\/backends\/([A-Za-z0-9-]+)\/ping$/)
  if (pingBackend && m === 'POST') {
    await handlePing(res, pingBackend[1]); return true
  }
  return false
}

// ─── handlers ───────────────────────────────────────────────────────

async function handleList(res: ServerResponse): Promise<void> {
  const cfg = await readConfig()
  const backends = (cfg.llmBackends ?? []).map((b) => {
    // v1.2.141 — pass backend hint so describeSecretSource can report
    // vendor-env fallback (source='vendor') and surface candidate envs
    // when nothing is configured ('vendorCandidates').
    const src = describeSecretSource(b.name, { provider: b.provider, baseUrl: b.baseUrl })
    return {
      name: b.name,
      provider: b.provider,
      baseUrl: b.baseUrl,
      model: b.model,
      secret: {
        source: src.source,
        envKey: src.envKey,
        ...(src.vendorEnvName ? { vendorEnvName: src.vendorEnvName } : {}),
        ...(src.vendorCandidates && src.vendorCandidates.length > 0
          ? { vendorCandidates: src.vendorCandidates }
          : {}),
      },
    }
  })
  send(res, 200, {
    backends,
    roles: cfg.llmRoles ?? {},
  })
}

async function handleAddBackend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{
    name?: unknown
    provider?: unknown
    baseUrl?: unknown
    model?: unknown
    apiKey?: unknown
  }>(req)
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'request body must be a JSON object' })
    return
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const provider = body.provider
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) {
    send(res, 400, { error: 'name is required and must match [A-Za-z0-9][A-Za-z0-9-]*' })
    return
  }
  if (provider !== 'openai-compat' && provider !== 'anthropic') {
    send(res, 400, { error: 'provider must be "openai-compat" or "anthropic"' })
    return
  }
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    send(res, 400, { error: 'baseUrl must be an http(s) URL' })
    return
  }
  if (!model) {
    send(res, 400, { error: 'model is required' })
    return
  }
  if (!apiKey) {
    send(res, 400, { error: 'apiKey is required (non-empty string)' })
    return
  }
  const next: RawBackend = { name, provider, baseUrl, model }
  let savedConfig: RawConfig
  try {
    const update = await updateConfigObject((current) => {
      const cfg = current as RawConfig
      const existing = cfg.llmBackends ?? []
      if (existing.some((b) => b.name === name)) {
        throw new LlmConfigError(409, `backend "${name}" already exists`)
      }
      const config = { ...cfg, llmBackends: [...existing, next] }
      const parsed = configSchema.safeParse(config)
      if (!parsed.success) {
        throw new LlmConfigError(
          400,
          'config validation failed',
          parsed.error.issues.map((i) => i.message),
        )
      }
      return { config, result: undefined }
    })
    savedConfig = update.config as RawConfig
  } catch (err) {
    if (!(err instanceof LlmConfigError)) throw err
    send(res, err.status, {
      error: err.message,
      ...(err.issues ? { issues: err.issues } : {}),
    })
    return
  }
  saveSecret(name, apiKey)
  refreshLlmRuntime(savedConfig)
  send(res, 201, { name, secretStored: true })
}

async function handleRemoveBackend(res: ServerResponse, name: string): Promise<void> {
  let savedConfig: RawConfig
  let removedRoles = 0
  try {
    const update = await updateConfigObject((current) => {
      const cfg = current as RawConfig
      const backends = cfg.llmBackends ?? []
      const next = backends.filter((b) => b.name !== name)
      if (next.length === backends.length) {
        throw new LlmConfigError(404, `no backend named "${name}"`)
      }
      const cleaned: Record<string, string> = {}
      removedRoles = 0
      for (const [role, backend] of Object.entries(cfg.llmRoles ?? {})) {
        if (backend === name) { removedRoles++; continue }
        cleaned[role] = backend
      }
      return {
        config: { ...cfg, llmBackends: next, llmRoles: cleaned },
        result: undefined,
      }
    })
    savedConfig = update.config as RawConfig
  } catch (err) {
    if (!(err instanceof LlmConfigError)) throw err
    send(res, err.status, { error: err.message })
    return
  }
  removeSecret(name)
  refreshLlmRuntime(savedConfig)
  send(res, 200, { removedRoles })
}

async function handlePutRoles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<Record<string, unknown>>(req)
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'request body must be a JSON object' })
    return
  }
  let savedConfig: RawConfig
  let nextRoles: Record<string, string> = {}
  try {
    const update = await updateConfigObject((stored) => {
      const cfg = stored as RawConfig
      const backendNames = new Set((cfg.llmBackends ?? []).map((b) => b.name))
      nextRoles = { ...(cfg.llmRoles ?? {}) }
      for (const [rawRole, rawValue] of Object.entries(body)) {
        const role = rawRole.trim()
        if (!role) continue
        if (rawValue === null || rawValue === '' || rawValue === undefined) {
          delete nextRoles[role]
          continue
        }
        if (typeof rawValue !== 'string') {
          throw new LlmConfigError(400, `role "${role}" must be a string (backend name) or null/empty to unbind`)
        }
        const target = rawValue.trim()
        if (!backendNames.has(target)) {
          throw new LlmConfigError(400, `role "${role}" references unknown backend "${target}"`)
        }
        nextRoles[role] = target
      }
      const config = { ...cfg, llmRoles: nextRoles }
      const parsed = configSchema.safeParse(config)
      if (!parsed.success) {
        throw new LlmConfigError(
          400,
          'config validation failed',
          parsed.error.issues.map((i) => i.message),
        )
      }
      return { config, result: undefined }
    })
    savedConfig = update.config as RawConfig
  } catch (err) {
    if (!(err instanceof LlmConfigError)) throw err
    send(res, err.status, {
      error: err.message,
      ...(err.issues ? { issues: err.issues } : {}),
    })
    return
  }
  refreshLlmRuntime(savedConfig)
  send(res, 200, { roles: nextRoles })
}

async function handleSetSecret(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  const cfg = await readConfig()
  if (!(cfg.llmBackends ?? []).some((b) => b.name === name)) {
    send(res, 404, { error: `no backend named "${name}"` })
    return
  }
  const body = await readJsonBody<{ apiKey?: unknown }>(req)
  if (!body || typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
    send(res, 400, { error: 'apiKey is required (non-empty string)' })
    return
  }
  saveSecret(name, body.apiKey.trim())
  refreshLlmRuntime(cfg)
  const src = describeSecretSource(name)
  send(res, 200, { name, source: src.source })
}

async function handleRemoveSecret(res: ServerResponse, name: string): Promise<void> {
  removeSecret(name)
  refreshLlmRuntime(await readConfig())
  send(res, 200, { name })
}

async function handlePing(res: ServerResponse, name: string): Promise<void> {
  // Stage 6 — backend ping. Loads the config (so a newly-added backend
  // is reachable even before agim restarts), looks up the provider,
  // and issues a tiny chat probe ('ping') with a tight timeout. The
  // response shape is operator-debug-flavored: ok / errorClass / ms /
  // sampleText / tokens. Failures DO NOT throw — they land as ok:false
  // with a readable error string the UI can show.
  const cfg = await readConfig()
  if (!(cfg.llmBackends ?? []).some((b) => b.name === name)) {
    send(res, 404, { error: `no backend named "${name}"` })
    return
  }
  loadLlmFromConfig(cfg)
  const provider = getProviderByName(name)
  if (!provider) {
    send(res, 200, {
      name, ok: false,
      error: 'backend not in registry (likely missing API key)',
    })
    return
  }
  const startedAt = Date.now()
  try {
    const r = await provider.chat(
      [{ role: 'user', content: 'ping' }],
      { timeoutMs: 10_000, maxTokens: 16 },
    )
    send(res, 200, {
      name, ok: true,
      durationMs: Date.now() - startedAt,
      tokensIn: r.usage.promptTokens,
      tokensOut: r.usage.completionTokens,
      sampleText: r.text.slice(0, 200),
    })
  } catch (err) {
    send(res, 200, {
      name, ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── disk helpers ───────────────────────────────────────────────────

async function readConfig(): Promise<RawConfig> {
  return await readConfigObject<RawConfig>()
}

function refreshLlmRuntime(cfg: RawConfig): void {
  loadLlmFromConfig(cfg)
  // Agent availability probes are TTL-cached; clear so native switch can
  // succeed immediately after backend/key changes.
  clearAgentCache()
}
