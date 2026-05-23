// llm-api — web REST surface for the Stage 4 LLM-backend configuration
// UX. Mirrors what `agim setup llm` does on the CLI side, but lives
// behind the existing web auth model (operators only — gated by
// requireAdmin in the caller).
//
// Endpoints exposed:
//
//   GET    /api/llm                      → { backends, roles, status }
//   POST   /api/llm/backends             body { name, provider, baseUrl, model, apiKey? }
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
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { AGIM_HOME } from '../core/agim-paths.js'
import { configSchema } from '../core/config-schema.js'
import {
  saveSecret, removeSecret, describeSecretSource,
} from '../core/llm/secrets.js'

const CONFIG_FILE = join(AGIM_HOME, 'config.json')

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
  return false
}

// ─── handlers ───────────────────────────────────────────────────────

async function handleList(res: ServerResponse): Promise<void> {
  const cfg = await readConfig()
  const backends = (cfg.llmBackends ?? []).map((b) => {
    const src = describeSecretSource(b.name)
    return {
      name: b.name,
      provider: b.provider,
      baseUrl: b.baseUrl,
      model: b.model,
      secret: { source: src.source, envKey: src.envKey },
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
  const cfg = await readConfig()
  const existing = cfg.llmBackends ?? []
  if (existing.some((b) => b.name === name)) {
    send(res, 409, { error: `backend "${name}" already exists` })
    return
  }
  const next: RawBackend = { name, provider, baseUrl, model }
  cfg.llmBackends = [...existing, next]
  const parsed = configSchema.safeParse(cfg)
  if (!parsed.success) {
    send(res, 400, {
      error: 'config validation failed',
      issues: parsed.error.issues.map((i) => i.message),
    })
    return
  }
  await writeConfig(cfg)
  if (apiKey) saveSecret(name, apiKey)
  send(res, 201, { name, secretStored: !!apiKey })
}

async function handleRemoveBackend(res: ServerResponse, name: string): Promise<void> {
  const cfg = await readConfig()
  const backends = cfg.llmBackends ?? []
  const next = backends.filter((b) => b.name !== name)
  if (next.length === backends.length) {
    send(res, 404, { error: `no backend named "${name}"` })
    return
  }
  cfg.llmBackends = next
  const roles = cfg.llmRoles ?? {}
  const cleaned: Record<string, string> = {}
  let removedRoles = 0
  for (const [r, b] of Object.entries(roles)) {
    if (b === name) { removedRoles++; continue }
    cleaned[r] = b
  }
  cfg.llmRoles = cleaned
  await writeConfig(cfg)
  removeSecret(name)
  send(res, 200, { removedRoles })
}

async function handlePutRoles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<Record<string, unknown>>(req)
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'request body must be a JSON object' })
    return
  }
  const cfg = await readConfig()
  const backendNames = new Set((cfg.llmBackends ?? []).map((b) => b.name))
  const current = cfg.llmRoles ?? {}
  const next: Record<string, string> = { ...current }
  for (const [rawRole, rawValue] of Object.entries(body)) {
    const role = rawRole.trim()
    if (!role) continue
    if (rawValue === null || rawValue === '' || rawValue === undefined) {
      delete next[role]
      continue
    }
    if (typeof rawValue !== 'string') {
      send(res, 400, { error: `role "${role}" must be a string (backend name) or null/empty to unbind` })
      return
    }
    const target = rawValue.trim()
    if (!backendNames.has(target)) {
      send(res, 400, { error: `role "${role}" references unknown backend "${target}"` })
      return
    }
    next[role] = target
  }
  cfg.llmRoles = next
  const parsed = configSchema.safeParse(cfg)
  if (!parsed.success) {
    send(res, 400, {
      error: 'config validation failed',
      issues: parsed.error.issues.map((i) => i.message),
    })
    return
  }
  await writeConfig(cfg)
  send(res, 200, { roles: next })
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
  const src = describeSecretSource(name)
  send(res, 200, { name, source: src.source })
}

async function handleRemoveSecret(res: ServerResponse, name: string): Promise<void> {
  removeSecret(name)
  send(res, 200, { name })
}

// ─── disk helpers ───────────────────────────────────────────────────

async function readConfig(): Promise<RawConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(raw) as RawConfig
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function writeConfig(cfg: RawConfig): Promise<void> {
  await mkdir(AGIM_HOME, { recursive: true, mode: 0o700 })
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { await chmod(CONFIG_FILE, 0o600) } catch { /* ignore on Windows */ }
}
