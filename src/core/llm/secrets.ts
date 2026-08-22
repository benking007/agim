// LLM secrets store — `~/.agim/llm-secrets.json` with 0600 perms.
//
// Why a separate file (not the main config):
//   - config.json is committed/backed up in many user setups; api keys
//     belong somewhere we can chmod 0600 without changing user habits.
//   - Aligns with the same pattern used for the web token files — secrets
//     live next to their public config but stay in
//     their own file.
//
// File format (intentionally tiny):
//   {
//     "version": 1,
//     "keys": { "<vendor-or-backend-name>": "<api-key>" }
//   }
//
// Built-in vendors share one slot (`keys.deepseek`, `keys.moonshot`, …)
// so a new catalog model does not need a new secrets entry. Custom
// backends still use the backend name. Older installs that stored
// `keys.deepseek-v4-pro` keep working (read-only fallback).
//
// Lookup precedence (callers go through `resolveSecret`):
//   1. process.env `AGIM_LLM_SECRET_<UPPER_BACKEND_NAME>` — per-backend override.
//   2. process.env `AGIM_LLM_SECRET_<VENDOR>` (e.g. `AGIM_LLM_SECRET_DEEPSEEK`).
//   3. ~/.agim/llm-secrets.json vendor slot, then legacy per-model names
//      (this backend + sibling names in the same vendor group).
//   4. Vendor-standard env (DEEPSEEK_API_KEY / OPENAI_API_KEY / …) when
//      the caller passes a `backendHint` with provider + baseUrl.
//   5. undefined (provider will report isConfigured()=false).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from '../agim-paths.js'
import { logger as rootLogger } from '../logger.js'
import { builtinPresetKeyForBaseUrl, isBuiltinPresetKey } from './presets.js'

const log = rootLogger.child({ component: 'llm-secrets' })

export const LLM_SECRETS_PATH = join(AGIM_HOME, 'llm-secrets.json')

interface SecretsFile {
  version: number
  keys: Record<string, string>
}

function emptyFile(): SecretsFile {
  // Fresh object every call. Returning a shared `EMPTY` const would let
  // a caller's mutation (e.g. saveSecret stamping the keys map) leak
  // back into the next loadSecretsFile() call. Cheap to allocate.
  return { version: 1, keys: {} }
}

/** Convert a backend name to the env var suffix. Same rule as the rest
 *  of the codebase: non-alphanumeric → underscore, uppercased. So
 *  "deepseek-cheap" → "AGIM_LLM_SECRET_DEEPSEEK_CHEAP". */
export function envKeyForBackend(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
  return `AGIM_LLM_SECRET_${safe}`
}

/** Vendor hint passed by the registry so we can fall back to standard
 *  vendor envs (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …). Optional —
 *  callers from CLI tests etc. can omit it and only see Agim-managed
 *  lookup paths. */
export interface BackendHint {
  provider?: string
  baseUrl?: string
  /** Preset / vendor id (`deepseek`, `moonshot`). One key covers every model. */
  label?: string
  /** Other backend names that share this vendor (legacy per-model file keys). */
  siblingNames?: string[]
}

export interface SecretBackendRef {
  name: string
  provider?: string
  baseUrl?: string
  label?: string
}

interface VendorRule {
  /** Matched against baseUrl.toLowerCase(); empty string means "no
   *  baseUrl needed" (used by the anthropic provider which has a fixed
   *  default endpoint). */
  match: string
  /** Optional extra constraint on `BackendHint.provider`. */
  provider?: string
  /** Env names to probe in order. First non-empty wins. */
  envNames: string[]
}

/** Built-in mapping of vendor → standard env names. baseUrl substring
 *  match is intentionally loose — `deepseek.com`, `api.deepseek.com`,
 *  `https://api.deepseek.com/v1` all hit the same rule. Order matters
 *  only when two rules overlap (none do today).
 *
 *  v1.2.141 — kept short and conservative on purpose. Adding a vendor
 *  is one line; over-matching is a footgun (you'd leak the wrong env
 *  into the wrong backend). Self-hosted gateways are deliberately NOT
 *  here — those operators should use `AGIM_LLM_SECRET_<NAME>`. */
const VENDOR_RULES: VendorRule[] = [
  { match: 'deepseek.com',                envNames: ['DEEPSEEK_API_KEY'] },
  { match: 'api.openai.com',              envNames: ['OPENAI_API_KEY'] },
  { match: 'moonshot.cn',                 envNames: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { match: 'moonshot.ai',                 envNames: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { match: 'kimi.com',                    envNames: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
  { match: 'kimi.ai',                     envNames: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
  { match: 'dashscope',                   envNames: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'] },
  { match: 'aliyuncs',                    envNames: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'] },
  { match: 'siliconflow',                 envNames: ['SILICONFLOW_API_KEY'] },
  { match: 'openrouter.ai',               envNames: ['OPENROUTER_API_KEY'] },
  { match: 'stepfun.com',                 envNames: ['STEPFUN_API_KEY'] },
  { match: 'bigmodel.cn',                 envNames: ['ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY'] },
  { match: 'api.z.ai',                    envNames: ['ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'] },
  { match: 'zhipuai',                     envNames: ['ZHIPUAI_API_KEY', 'ZAI_API_KEY'] },
  { match: 'xiaomimimo.com',              envNames: ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY'] },
  { match: 'mimo.mi.com',                 envNames: ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY'] },
  { match: 'minimaxi',                    envNames: ['MINIMAX_API_KEY'] },
  { match: 'baichuan-ai',                 envNames: ['BAICHUAN_API_KEY'] },
  { match: 'mistral.ai',                  envNames: ['MISTRAL_API_KEY'] },
  { match: 'groq.com',                    envNames: ['GROQ_API_KEY'] },
  { match: 'together.xyz',                envNames: ['TOGETHER_API_KEY'] },
  { match: 'fireworks.ai',                envNames: ['FIREWORKS_API_KEY'] },
  // Anthropic — baseUrl might be empty (provider uses its own default),
  // so we additionally key on provider name.
  { match: 'anthropic.com', provider: 'anthropic', envNames: ['ANTHROPIC_API_KEY'] },
  { match: '',              provider: 'anthropic', envNames: ['ANTHROPIC_API_KEY'] },
]

/**
 * Resolve via the vendor table. Returns the matched env name + value, or
 * null when no rule applies / matched rule's envs are all empty. The
 * env-name is surfaced so `describeSecretSource` can report which vendor
 * env was used (useful for the "Test connection" diagnostic).
 */
function resolveVendorEnv(hint: BackendHint | undefined): { envName: string; value: string } | null {
  if (!hint) return null
  const baseUrl = (hint.baseUrl ?? '').toLowerCase()
  const provider = (hint.provider ?? '').toLowerCase()
  for (const rule of VENDOR_RULES) {
    if (rule.provider && rule.provider !== provider) continue
    if (rule.match && !baseUrl.includes(rule.match)) continue
    if (!rule.match && !rule.provider) continue
    for (const envName of rule.envNames) {
      const v = process.env[envName]
      if (v && v.length > 0) return { envName, value: v }
    }
  }
  return null
}

/** Diagnostic — returns the list of vendor env names that would be
 *  probed for a given backend hint. Used by `describeSecretSource` to
 *  show the operator which envs are checked when both private slots
 *  are empty. */
export function vendorEnvCandidates(hint: BackendHint | undefined): string[] {
  if (!hint) return []
  const baseUrl = (hint.baseUrl ?? '').toLowerCase()
  const provider = (hint.provider ?? '').toLowerCase()
  const seen = new Set<string>()
  for (const rule of VENDOR_RULES) {
    if (rule.provider && rule.provider !== provider) continue
    if (rule.match && !baseUrl.includes(rule.match)) continue
    if (!rule.match && !rule.provider) continue
    for (const n of rule.envNames) seen.add(n)
  }
  return Array.from(seen)
}

/**
 * Read the on-disk secrets file (or return an empty SecretsFile if missing / corrupt).
 * Logs a warning on corrupt files so operators notice — we deliberately
 * don't throw because callers want the provider to gracefully report
 * "not configured" rather than crash agim at startup.
 */
export function loadSecretsFile(): SecretsFile {
  try {
    if (!existsSync(LLM_SECRETS_PATH)) return emptyFile()
    const raw = readFileSync(LLM_SECRETS_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SecretsFile>
    if (!parsed || typeof parsed !== 'object' || !parsed.keys || typeof parsed.keys !== 'object') {
      log.warn({ event: 'llm-secrets.malformed', path: LLM_SECRETS_PATH })
      return emptyFile()
    }
    // Coerce keys to strings; ignore non-string values silently.
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed.keys)) {
      if (typeof v === 'string' && v.length > 0) clean[k] = v
    }
    return { version: parsed.version === 1 ? 1 : 1, keys: clean }
  } catch (err) {
    log.warn({ event: 'llm-secrets.read_failed', err: String(err) })
    return emptyFile()
  }
}

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl?.trim()) return ''
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return baseUrl.toLowerCase()
  }
}

function vendorId(backend: SecretBackendRef): string | undefined {
  const label = backend.label?.trim().toLowerCase()
  if (label && isBuiltinPresetKey(label)) return label
  return builtinPresetKeyForBaseUrl(backend.baseUrl) ?? undefined
}

export function sameVendorGroup(a: SecretBackendRef, b: SecretBackendRef): boolean {
  const va = vendorId(a)
  const vb = vendorId(b)
  if (va && vb && va === vb) return true
  const la = a.label?.trim().toLowerCase()
  const lb = b.label?.trim().toLowerCase()
  if (la && lb && la === lb) return true
  const ha = hostOf(a.baseUrl)
  const hb = hostOf(b.baseUrl)
  return ha.length > 0 && ha === hb
}

function vendorSlot(_backendName: string, hint?: BackendHint): string | undefined {
  return vendorId({
    name: _backendName,
    provider: hint?.provider,
    baseUrl: hint?.baseUrl,
    label: hint?.label,
  })
}

/** File / env slot for a builtin vendor. Custom backends keep a per-name slot. */
export function secretSlotForBackend(backendName: string, hint?: BackendHint): string {
  return vendorSlot(backendName, hint) ?? backendName
}

export function secretHintForBackend(
  backend: SecretBackendRef,
  all: SecretBackendRef[] = [],
): BackendHint {
  return {
    provider: backend.provider,
    baseUrl: backend.baseUrl,
    label: backend.label,
    siblingNames: all
      .filter((other) => other.name !== backend.name && sameVendorGroup(backend, other))
      .map((other) => other.name),
  }
}

function fileKeysToTry(backendName: string, hint?: BackendHint): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const add = (k: string | undefined) => {
    const id = k?.trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    keys.push(id)
  }
  const slot = vendorSlot(backendName, hint)
  add(slot)
  add(backendName)
  if (slot) {
    for (const sibling of hint?.siblingNames ?? []) add(sibling)
  }
  return keys
}

/**
 * Resolve a single secret for a backend, applying env-var precedence.
 * Returns undefined when nothing is configured — providers downstream
 * use this to flip `isConfigured()` off.
 *
 * Pass a `backendHint` (label / baseUrl / siblings) so builtin vendors
 * share one file slot and legacy per-model keys still resolve.
 */
export function resolveSecret(
  backendName: string,
  fileSecrets?: SecretsFile,
  backendHint?: BackendHint,
): string | undefined {
  if (!backendName) return undefined
  const envVal = process.env[envKeyForBackend(backendName)]
  if (envVal && envVal.length > 0) return envVal
  const slot = vendorSlot(backendName, backendHint)
  if (slot && slot !== backendName) {
    const vendorEnv = process.env[envKeyForBackend(slot)]
    if (vendorEnv && vendorEnv.length > 0) return vendorEnv
  }
  const file = fileSecrets ?? loadSecretsFile()
  for (const key of fileKeysToTry(backendName, backendHint)) {
    const v = file.keys[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  const vendor = resolveVendorEnv(backendHint)
  if (vendor) return vendor.value
  return undefined
}

/**
 * Persist a secret. Idempotent — writes the entire file with 0600
 * perms. Used by the CLI wizard (`agim config llm add`) once we land
 * Stage 4; Stage 1 ships the helper so tests can exercise it.
 */
export function saveSecret(backendName: string, apiKey: string): void {
  if (!backendName) throw new Error('saveSecret: backendName is required')
  if (!apiKey) throw new Error('saveSecret: apiKey is required (use removeSecret to delete)')
  const file = loadSecretsFile()
  file.keys[backendName] = apiKey
  _writeFile(file)
}

/** Persist a key on the vendor slot for builtin presets (`keys.deepseek`). */
export function saveSecretForBackend(
  backendName: string,
  apiKey: string,
  hint?: BackendHint,
): void {
  saveSecret(secretSlotForBackend(backendName, hint), apiKey)
}

/** Clear the vendor slot (and leftover per-name key) for one backend. */
export function clearSecretForBackend(backendName: string, hint?: BackendHint): void {
  removeSecret(backendName)
  const slot = secretSlotForBackend(backendName, hint)
  if (slot !== backendName) removeSecret(slot)
}

/** Drop per-name leftovers; drop the vendor slot only when no sibling remains. */
export function removeSecretsForRemovedBackends(
  removed: SecretBackendRef[],
  remaining: SecretBackendRef[],
): void {
  for (const b of removed) {
    removeSecret(b.name)
    const slot = secretSlotForBackend(b.name, { label: b.label, baseUrl: b.baseUrl })
    if (slot === b.name) continue
    const stillUsed = remaining.some((r) =>
      secretSlotForBackend(r.name, { label: r.label, baseUrl: r.baseUrl }) === slot,
    )
    if (!stillUsed) removeSecret(slot)
  }
}

/** Remove a secret entirely. Safe to call on missing names. */
export function removeSecret(backendName: string): void {
  const file = loadSecretsFile()
  if (!(backendName in file.keys)) return
  delete file.keys[backendName]
  _writeFile(file)
}

/** Test helper: list configured backend names (no values). */
export function listConfiguredBackends(): string[] {
  return Object.keys(loadSecretsFile().keys).sort()
}

function _writeFile(file: SecretsFile): void {
  // Ensure the parent directory exists; AGIM_HOME might still be a fresh
  // install where nothing else has written yet.
  const dir = dirname(LLM_SECRETS_PATH)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Best-effort; if we can't even mkdir, the writeFile below will
    // throw a clearer error.
  }
  // Atomic replace (tmp + rename) so a crash mid-write cannot leave a
  // truncated secrets file. Same pattern as config-store (sync variant).
  const payload = `${JSON.stringify(file, null, 2)}\n`
  const tmpPath = `${LLM_SECRETS_PATH}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmpPath, LLM_SECRETS_PATH)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
  // writeFileSync's mode is advisory on some filesystems; chmodSync is
  // the belt-and-suspenders that matches how the bootstrap token writer
  // does it elsewhere in the codebase.
  try { chmodSync(LLM_SECRETS_PATH, 0o600) } catch { /* ignore */ }
}

/**
 * One-shot health check used by the CLI wizard + web "test backend"
 * button. Returns a short reason string when something looks off so the
 * UI doesn't have to guess. The string is operator-facing; keep it
 * succinct and actionable.
 */
export function describeSecretSource(
  backendName: string,
  backendHint?: BackendHint,
): {
  source: 'env' | 'file' | 'vendor' | 'none'
  envKey: string
  filePath: string
  /** v1.2.141 — when source==='vendor', this is the vendor env var
   *  name that actually held the secret (e.g. 'DEEPSEEK_API_KEY'). */
  vendorEnvName?: string
  /** v1.2.141 — when source==='none' but a backendHint was supplied,
   *  the candidate vendor envs we tried (helps operators figure out
   *  which standard env to set). */
  vendorCandidates?: string[]
  perms?: string
} {
  const envKey = envKeyForBackend(backendName)
  if (process.env[envKey]) return { source: 'env', envKey, filePath: LLM_SECRETS_PATH }
  const slot = vendorSlot(backendName, backendHint)
  if (slot && slot !== backendName && process.env[envKeyForBackend(slot)]) {
    return { source: 'env', envKey: envKeyForBackend(slot), filePath: LLM_SECRETS_PATH }
  }
  const file = loadSecretsFile()
  if (fileKeysToTry(backendName, backendHint).some((key) => file.keys[key])) {
    let perms: string | undefined
    try {
      const st = statSync(LLM_SECRETS_PATH)
      perms = `0${(st.mode & 0o777).toString(8)}`
    } catch { /* ignore */ }
    return { source: 'file', envKey, filePath: LLM_SECRETS_PATH, perms }
  }
  const vendor = resolveVendorEnv(backendHint)
  if (vendor) {
    return {
      source: 'vendor', envKey, filePath: LLM_SECRETS_PATH,
      vendorEnvName: vendor.envName,
    }
  }
  return {
    source: 'none', envKey, filePath: LLM_SECRETS_PATH,
    vendorCandidates: vendorEnvCandidates(backendHint),
  }
}
