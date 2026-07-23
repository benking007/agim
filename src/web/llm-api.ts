// llm-api — web REST surface for the Stage 4 LLM-backend configuration
// UX. Mirrors what `agim setup llm` does on the CLI side, but lives
// behind the existing web auth model (operators only — gated by
// requireAdmin in the caller).
//
// Endpoints exposed:
//
//   GET    /api/llm                      → { backends, roles, status }
//   GET    /api/llm/presets              → curated vendor presets (DeepSeek default)
//   POST   /api/llm/quick-enable         body { apiKey, preset?, model?, baseUrl?, name? }
//                                        → 201 Created (backend + roles + defaultAgent)
//   POST   /api/llm/backends             body { name, provider, baseUrl, model, apiKey }
//                                        → 201 Created or 409 Conflict / 400 Validation
//   DELETE /api/llm/backends/:name       → 200 OK { removedRoles }
//   DELETE /api/llm/backends?label=…     → 200 OK { removed, removedRoles }  (atomic group)
//   DELETE /api/llm/backends?names=a,b   → 200 OK { removed, removedRoles }  (atomic multi)
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
import { lookupModelMeta } from '../core/llm/model-catalog.js'
import { DEFAULT_LLM_PRESET, LLM_PRESETS } from '../core/llm/presets.js'
import { QuickEnableError, quickEnableLlmPreset } from '../core/llm/quick-enable.js'

interface RawBackend {
  name: string
  provider: 'openai-compat' | 'anthropic'
  baseUrl: string
  model: string
  /** Preset key (deepseek / …) when created via quick-enable. */
  label?: string
  temperature?: number
  maxTokens?: number
  contextWindow?: number
  thinkingFormat?: 'off' | 'deepseek' | 'openai'
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  extraHeaders?: Record<string, string>
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
  if (p === '/api/llm/presets' && m === 'GET') {
    handlePresets(res); return true
  }
  if (p === '/api/llm/quick-enable' && m === 'POST') {
    await handleQuickEnable(req, res); return true
  }
  if (p === '/api/llm/backends' && m === 'POST') {
    await handleAddBackend(req, res); return true
  }
  // CR M2 — atomic group delete (label= or names=). Must run before the
  // /backends/:name matcher so the collection path is not swallowed.
  if (p === '/api/llm/backends' && m === 'DELETE') {
    await handleRemoveBackendGroup(res, url); return true
  }
  if (p === '/api/llm/roles' && m === 'PUT') {
    await handlePutRoles(req, res); return true
  }
  // Backend names may include `.` / `_` (e.g. kimi-k2.6) — keep in sync with
  // config-schema `safeNamePattern`.
  const rmBackend = p.match(/^\/api\/llm\/backends\/([A-Za-z0-9._-]+)$/)
  if (rmBackend && m === 'DELETE') {
    await handleRemoveBackend(res, decodeURIComponent(rmBackend[1])); return true
  }
  const setSecret = p.match(/^\/api\/llm\/secrets\/([A-Za-z0-9._%-]+)$/)
  if (setSecret && m === 'POST') {
    await handleSetSecret(req, res, decodeURIComponent(setSecret[1])); return true
  }
  if (setSecret && m === 'DELETE') {
    await handleRemoveSecret(res, decodeURIComponent(setSecret[1])); return true
  }
  const pingBackend = p.match(/^\/api\/llm\/backends\/([A-Za-z0-9._-]+)\/ping$/)
  if (pingBackend && m === 'POST') {
    await handlePing(res, decodeURIComponent(pingBackend[1])); return true
  }
  return false
}

// ─── handlers ───────────────────────────────────────────────────────

function handlePresets(res: ServerResponse): void {
  send(res, 200, {
    defaultPreset: DEFAULT_LLM_PRESET.key,
    presets: LLM_PRESETS.map((p) => ({
      key: p.key,
      label: p.label,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      cheapModel: p.cheapModel,
      models: p.models ?? [p.model, p.cheapModel].filter(Boolean),
      baseName: p.baseName,
      apiKeyDoc: p.apiKeyDoc,
      defaultThinking: p.defaultThinking,
    })),
  })
}

async function handleQuickEnable(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{
    preset?: unknown
    apiKey?: unknown
    name?: unknown
    model?: unknown
    baseUrl?: unknown
    bindCheapRoles?: unknown
    setDefaultAgent?: unknown
  }>(req)
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'request body must be a JSON object' })
    return
  }
  if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
    send(res, 400, { error: 'apiKey is required (non-empty string)' })
    return
  }
  try {
    const result = await quickEnableLlmPreset({
      preset: typeof body.preset === 'string' ? body.preset : undefined,
      apiKey: body.apiKey,
      name: typeof body.name === 'string' ? body.name : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      bindCheapRoles: body.bindCheapRoles !== false,
      setDefaultAgent: body.setDefaultAgent !== false,
    })
    send(res, 201, result)
  } catch (err) {
    if (err instanceof QuickEnableError) {
      const status = err.code === 'conflict' ? 409 : 400
      send(res, status, { error: err.message })
      return
    }
    throw err
  }
}

async function handleList(res: ServerResponse): Promise<void> {
  const cfg = await readConfig()
  const backends = (cfg.llmBackends ?? []).map((b) => {
    // v1.2.141 — pass backend hint so describeSecretSource can report
    // vendor-env fallback (source='vendor') and surface candidate envs
    // when nothing is configured ('vendorCandidates').
    const src = describeSecretSource(b.name, { provider: b.provider, baseUrl: b.baseUrl })
    // Prefer operator override; else fill from pi catalog so Usage / status
    // bar match the Agim Agent binding (e.g. deepseek-v4-pro → 1M / 384K).
    const catalog = lookupModelMeta(b.provider, b.model)
    const contextWindow = typeof b.contextWindow === 'number'
      ? b.contextWindow
      : catalog?.contextWindow
    const maxTokens = typeof b.maxTokens === 'number'
      ? b.maxTokens
      : catalog?.maxTokens
    return {
      name: b.name,
      provider: b.provider,
      baseUrl: b.baseUrl,
      model: b.model,
      ...(b.label ? { label: b.label } : {}),
      ...(typeof b.temperature === 'number' ? { temperature: b.temperature } : {}),
      ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      // Include 'off' (falsy string) so the SPA can round-trip an explicit disable.
      ...(b.thinkingFormat !== undefined ? { thinkingFormat: b.thinkingFormat } : {}),
      ...(b.maxTokensField ? { maxTokensField: b.maxTokensField } : {}),
      ...(b.extraHeaders && Object.keys(b.extraHeaders).length > 0
        ? { extraHeaders: redactExtraHeaders(b.extraHeaders) }
        : {}),
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

function parseOptionalNumber(value: unknown, field: string, min: number, max: number): number | undefined | { error: string } {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    return { error: `${field} must be a number between ${min} and ${max}` }
  }
  return n
}

/** Header names whose values must never round-trip to the SPA. */
const SENSITIVE_HEADER_RE = /^(authorization|api-key|x-api-key|x-auth-token|proxy-authorization)$/i

/** List API: keep header keys, mask secret-bearing values. */
export function redactExtraHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '***' : v
  }
  return out
}

function parseExtraHeaders(value: unknown): Record<string, string> | undefined | { error: string } {
  if (value === undefined || value === null || value === '') return undefined
  const out: Record<string, string> = {}
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf(':')
      if (idx <= 0) return { error: 'extraHeaders lines must look like "Header-Name: value"' }
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      if (!key) return { error: 'extraHeaders lines must look like "Header-Name: value"' }
      // Authorization is owned by the secrets layer — reject overrides.
      if (/^authorization$/i.test(key)) {
        return { error: 'extraHeaders must not include Authorization (use apiKey / llm-secrets)' }
      }
      out[key] = val
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v !== 'string') return { error: 'extraHeaders values must be strings' }
      const key = k.trim()
      if (!key) continue
      if (/^authorization$/i.test(key)) {
        return { error: 'extraHeaders must not include Authorization (use apiKey / llm-secrets)' }
      }
      out[key] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return { error: 'extraHeaders must be an object or Header: value lines' }
}

async function handleAddBackend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{
    name?: unknown
    provider?: unknown
    baseUrl?: unknown
    model?: unknown
    apiKey?: unknown
    temperature?: unknown
    maxTokens?: unknown
    contextWindow?: unknown
    thinkingFormat?: unknown
    maxTokensField?: unknown
    extraHeaders?: unknown
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
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    send(res, 400, { error: 'name is required and must match [A-Za-z0-9][A-Za-z0-9._-]*' })
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
  // CR P1a — same SSRF posture as ACP discover/test. API keys are stored
  // separately, so we don't force https here (local Ollama often uses http);
  // private / link-local / metadata addresses still require AGIM_URL_ALLOW_PRIVATE=1.
  {
    const { assertSafeAcpUrl, UnsafeAcpUrlError } = await import('../plugins/agents/acp/url-guard.js')
    try {
      await assertSafeAcpUrl(baseUrl, { forwardsCredentials: false })
    } catch (err) {
      if (err instanceof UnsafeAcpUrlError) {
        send(res, 400, { error: `baseUrl blocked: ${err.message}`, reason: err.reason })
        return
      }
      throw err
    }
  }
  if (!model) {
    send(res, 400, { error: 'model is required' })
    return
  }
  if (!apiKey) {
    send(res, 400, { error: 'apiKey is required (non-empty string)' })
    return
  }
  const temperature = parseOptionalNumber(body.temperature, 'temperature', 0, 2)
  if (typeof temperature === 'object' && temperature !== null && 'error' in temperature) {
    send(res, 400, { error: temperature.error })
    return
  }
  const maxTokens = parseOptionalNumber(body.maxTokens, 'maxTokens', 1, 2_000_000)
  if (typeof maxTokens === 'object' && maxTokens !== null && 'error' in maxTokens) {
    send(res, 400, { error: maxTokens.error })
    return
  }
  const contextWindow = parseOptionalNumber(body.contextWindow, 'contextWindow', 4_096, 2_000_000)
  if (typeof contextWindow === 'object' && contextWindow !== null && 'error' in contextWindow) {
    send(res, 400, { error: contextWindow.error })
    return
  }
  const thinkingFormat = body.thinkingFormat === undefined || body.thinkingFormat === '' || body.thinkingFormat === 'auto'
    ? undefined
    : body.thinkingFormat
  if (thinkingFormat !== undefined
    && thinkingFormat !== 'off'
    && thinkingFormat !== 'deepseek'
    && thinkingFormat !== 'openai') {
    send(res, 400, { error: 'thinkingFormat must be off, deepseek, or openai' })
    return
  }
  const maxTokensField = body.maxTokensField === undefined || body.maxTokensField === '' || body.maxTokensField === 'auto'
    ? undefined
    : body.maxTokensField
  if (maxTokensField !== undefined
    && maxTokensField !== 'max_tokens'
    && maxTokensField !== 'max_completion_tokens') {
    send(res, 400, { error: 'maxTokensField must be max_tokens or max_completion_tokens' })
    return
  }
  const extraHeaders = parseExtraHeaders(body.extraHeaders)
  if (typeof extraHeaders === 'object' && extraHeaders !== null && 'error' in extraHeaders) {
    send(res, 400, { error: extraHeaders.error })
    return
  }
  const next: RawBackend = {
    name,
    provider,
    baseUrl,
    model,
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    ...(thinkingFormat !== undefined ? { thinkingFormat } : {}),
    ...(maxTokensField !== undefined ? { maxTokensField } : {}),
    ...(extraHeaders && typeof extraHeaders === 'object' ? { extraHeaders } : {}),
  }
  let savedConfig: RawConfig
  try {
    const update = await updateConfigObject((current) => {
      const cfg = current as RawConfig
      const existing = cfg.llmBackends ?? []
      if (existing.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
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

/**
 * DELETE /api/llm/backends?label=<presetKey>
 * DELETE /api/llm/backends?names=a,b,c
 *
 * Atomic multi-remove inside one config-store transaction (CR M2).
 * Secrets for every removed name are deleted after the write succeeds.
 */
async function handleRemoveBackendGroup(res: ServerResponse, url: URL): Promise<void> {
  const label = (url.searchParams.get('label') || '').trim().toLowerCase()
  const namesParam = (url.searchParams.get('names') || '').trim()
  const names = namesParam
    ? [...new Set(namesParam.split(',').map((s) => s.trim()).filter(Boolean))]
    : []
  if (!label && names.length === 0) {
    send(res, 400, { error: 'query label= or names= is required' })
    return
  }
  if (label && names.length > 0) {
    send(res, 400, { error: 'pass only one of label= or names=' })
    return
  }

  let savedConfig: RawConfig
  let removedNames: string[] = []
  let removedRoles = 0
  try {
    const update = await updateConfigObject((current) => {
      const cfg = current as RawConfig
      const backends = cfg.llmBackends ?? []
      const toRemove = new Set<string>()
      if (label) {
        for (const b of backends) {
          if ((b.label ?? '').trim().toLowerCase() === label) toRemove.add(b.name)
        }
      } else {
        const known = new Set(backends.map((b) => b.name))
        for (const n of names) {
          if (known.has(n)) toRemove.add(n)
        }
      }
      if (toRemove.size === 0) {
        throw new LlmConfigError(
          404,
          label ? `no backends with label "${label}"` : 'no matching backends to remove',
        )
      }
      const next = backends.filter((b) => !toRemove.has(b.name))
      const cleaned: Record<string, string> = {}
      removedRoles = 0
      for (const [role, backend] of Object.entries(cfg.llmRoles ?? {})) {
        if (toRemove.has(backend)) { removedRoles++; continue }
        cleaned[role] = backend
      }
      removedNames = [...toRemove]
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
  for (const name of removedNames) {
    try { removeSecret(name) } catch { /* best-effort */ }
  }
  refreshLlmRuntime(savedConfig)
  send(res, 200, { removed: removedNames, removedRoles })
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
