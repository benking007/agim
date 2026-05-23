// LLM secrets store — `~/.agim/llm-secrets.json` with 0600 perms.
//
// Why a separate file (not the main config):
//   - config.json is committed/backed up in many user setups; api keys
//     belong somewhere we can chmod 0600 without changing user habits.
//   - Aligns with the same pattern used for `~/.agim/acp-token` and the
//     web token — secrets live next to their public config but stay in
//     their own file.
//
// File format (intentionally tiny):
//   {
//     "version": 1,
//     "keys": { "<backend-name>": "<api-key>" }
//   }
//
// Lookup precedence (callers go through `resolveSecret`):
//   1. process.env `AGIM_LLM_SECRET_<UPPER_BACKEND_NAME>` — wins.
//      Lets systemd unit files / CI / cloud agents inject without
//      touching the on-disk file. Hyphens in the backend name are
//      converted to underscores for the env var name.
//   2. ~/.agim/llm-secrets.json `keys.<backend-name>`.
//   3. undefined (provider will report isConfigured()=false).

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from '../agim-paths.js'
import { logger as rootLogger } from '../logger.js'

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

/**
 * Resolve a single secret for a backend, applying env-var precedence.
 * Returns undefined when nothing is configured — providers downstream
 * use this to flip `isConfigured()` off.
 */
export function resolveSecret(backendName: string, fileSecrets?: SecretsFile): string | undefined {
  if (!backendName) return undefined
  const envKey = envKeyForBackend(backendName)
  const envVal = process.env[envKey]
  if (envVal && envVal.length > 0) return envVal
  const file = fileSecrets ?? loadSecretsFile()
  const v = file.keys[backendName]
  return typeof v === 'string' && v.length > 0 ? v : undefined
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
  const payload = `${JSON.stringify(file, null, 2)}\n`
  writeFileSync(LLM_SECRETS_PATH, payload, { encoding: 'utf-8', mode: 0o600 })
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
export function describeSecretSource(backendName: string): {
  source: 'env' | 'file' | 'none'
  envKey: string
  filePath: string
  perms?: string
} {
  const envKey = envKeyForBackend(backendName)
  if (process.env[envKey]) return { source: 'env', envKey, filePath: LLM_SECRETS_PATH }
  const file = loadSecretsFile()
  if (file.keys[backendName]) {
    let perms: string | undefined
    try {
      const st = statSync(LLM_SECRETS_PATH)
      perms = `0${(st.mode & 0o777).toString(8)}`
    } catch { /* ignore */ }
    return { source: 'file', envKey, filePath: LLM_SECRETS_PATH, perms }
  }
  return { source: 'none', envKey, filePath: LLM_SECRETS_PATH }
}
