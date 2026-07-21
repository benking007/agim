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
//     "keys": { "<backend-name>": "<api-key>" }
//   }
//
// Lookup precedence (callers go through `resolveSecret`):
//   1. process.env `AGIM_LLM_SECRET_<UPPER_BACKEND_NAME>` — wins.
//      Lets systemd unit files / CI / cloud agents inject without
//      touching the on-disk file. Hyphens in the backend name are
//      converted to underscores for the env var name.
//   2. ~/.agim/llm-secrets.json `keys.<backend-name>`.
//   3. v1.2.141 — vendor-standard env (DEEPSEEK_API_KEY / OPENAI_API_KEY /
//      ANTHROPIC_API_KEY / …) when the caller passes a `backendHint` with
//      provider + baseUrl. Matched by baseUrl substring against a small
//      built-in table so a user who already exported the vendor's
//      standard env (which DeepSeek/OpenAI/Moonshot/etc SDKs all read by
//      default) gets agim working out of the box — no separate copy of
//      the same secret under `AGIM_LLM_SECRET_*`.
//   4. undefined (provider will report isConfigured()=false).

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

/** Vendor hint passed by the registry so we can fall back to standard
 *  vendor envs (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …). Optional —
 *  callers from CLI tests etc. can omit it and only see Agim-managed
 *  lookup paths. */
export interface BackendHint {
  provider?: string
  baseUrl?: string
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

/**
 * Resolve a single secret for a backend, applying env-var precedence.
 * Returns undefined when nothing is configured — providers downstream
 * use this to flip `isConfigured()` off.
 *
 * v1.2.141 — `backendHint` enables vendor-env fallback. Callers that
 * have backend config in hand (registry.ts) should pass it so users
 * who exported `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / etc. via vendor
 * convention don't also need to copy the value into our private
 * `AGIM_LLM_SECRET_*` namespace.
 */
export function resolveSecret(
  backendName: string,
  fileSecrets?: SecretsFile,
  backendHint?: BackendHint,
): string | undefined {
  if (!backendName) return undefined
  const envKey = envKeyForBackend(backendName)
  const envVal = process.env[envKey]
  if (envVal && envVal.length > 0) return envVal
  const file = fileSecrets ?? loadSecretsFile()
  const v = file.keys[backendName]
  if (typeof v === 'string' && v.length > 0) return v
  // v1.2.141 — vendor env fallback. Only consulted when both private
  // slots came up empty so existing installs see no behavior change.
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
  const file = loadSecretsFile()
  if (file.keys[backendName]) {
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
