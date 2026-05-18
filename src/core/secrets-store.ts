// secrets-store — split sensitive config fields out of ~/.agim/config.json
// into a sibling ~/.agim/secrets.json.
//
// Why split:
//   Tokens (telegram.botToken / feishu.appSecret / discord.botToken) sit
//   next to non-sensitive setup (agent list, default agent, port numbers)
//   in config.json. Operators who treat ~/.agim/ as a dotfile / want to
//   `agim config dump` for support / take filesystem snapshots end up
//   shipping the tokens through whichever channel handles the config.
//   Splitting lets them route secrets.json to a vault path (or `chmod 600`-
//   only, or env-var injection at deploy time) while keeping the rest in
//   version control if they wish.
//
// Migration strategy:
//   - Load: read config.json, then read secrets.json (if exists) and
//     overlay it on the in-memory config. Adapters see the merged shape
//     unchanged.
//   - Save: split() the config into { public, secrets } based on the
//     known-sensitive path list, write each to its own file. First save
//     after upgrade implicitly migrates the secrets out of config.json
//     because saveConfig() writes only the `public` half there.
//   - There is NO auto-migration on read alone — secrets stay where the
//     operator last wrote them. The next saveConfig (e.g. via the
//     Settings UI, the onboarding wizard, or a CLI editor) performs the
//     migration as a side effect.
//
// Out-of-scope for v1 of this split:
//   - acpAgents[*].auth.token  (per-agent bearer tokens — nested in an
//     array, needs path-rewriting logic. Operators with many ACP agents
//     should manually move them.)
//   - dingtalk.clientSecret (config schema doesn't currently surface it
//     as required; will be added when dingtalk lands officially.)

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'secrets-store' })

export const SECRETS_FILE = join(AGIM_HOME, 'secrets.json')

/**
 * Dotted paths into the config object that we treat as sensitive and
 * route to secrets.json. The list is intentionally small + explicit so
 * a code-review of secrets-store covers the entire migration surface.
 *
 * Order matters only for readability; split/merge iterate independently.
 */
export const SENSITIVE_PATHS: readonly string[] = [
  'telegram.botToken',
  'feishu.appSecret',
  'discord.botToken',
]

type Json = Record<string, unknown>

function getPath(obj: Json | undefined, path: string): unknown {
  if (!obj) return undefined
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Json)[seg]
  }
  return cur
}

function setPath(obj: Json, path: string, value: unknown): void {
  const segs = path.split('.')
  let cur: Json = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]
    const next = cur[k]
    if (next === null || next === undefined || typeof next !== 'object') {
      cur[k] = {}
    }
    cur = cur[k] as Json
  }
  cur[segs[segs.length - 1]] = value
}

function deletePath(obj: Json, path: string): boolean {
  const segs = path.split('.')
  let cur: Json | undefined = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur?.[segs[i]]
    if (next === null || next === undefined || typeof next !== 'object') return false
    cur = next as Json
  }
  if (!cur) return false
  const last = segs[segs.length - 1]
  if (!(last in cur)) return false
  delete cur[last]
  return true
}

/** Atomic 0o600 write: temp file in the same dir then rename. Survives
 *  a mid-write crash with at worst a leftover .tmp the next save sweeps. */
function atomicWriteSecure(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* non-POSIX */ }
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* non-POSIX */ }
  } catch (err) {
    // Clean up partial temp on failure so it doesn't accumulate.
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

/** Load the secrets sidecar. Returns {} when the file is missing or
 *  corrupt — corrupt is logged but never throws, so a manual edit gone
 *  wrong doesn't lock the operator out of starting the service. */
export function loadSecrets(): Json {
  if (!existsSync(SECRETS_FILE)) return {}
  try {
    const raw = readFileSync(SECRETS_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    log.warn({ event: 'secrets.unexpected_shape' }, 'secrets.json must be a JSON object; ignoring')
    return {}
  } catch (err) {
    log.warn({ event: 'secrets.parse_failed', err: String(err) },
      'secrets.json unreadable; falling back to empty (manual edit needed?)')
    return {}
  }
}

/** Persist the secrets sidecar. {} → unlink so an empty file doesn't
 *  litter the dotdir of an operator who isn't using messengers. */
export function saveSecrets(secrets: Json): void {
  const keys = Object.keys(secrets)
  if (keys.length === 0) {
    if (existsSync(SECRETS_FILE)) {
      try { unlinkSync(SECRETS_FILE) } catch { /* non-fatal */ }
    }
    return
  }
  atomicWriteSecure(SECRETS_FILE, JSON.stringify(secrets, null, 2))
}

/**
 * Split a merged config into { public, secrets } using SENSITIVE_PATHS.
 * The returned `public` is a deep-enough clone that mutating
 * `secrets` later doesn't affect it (we structure-clone the touched
 * subtree path). Non-touched fields share references with the input —
 * this is fine for our write-then-discard usage but callers that hold
 * `input` after split shouldn't rely on identity of secret subtrees.
 */
export function splitConfig(merged: Json): { publicCfg: Json; secrets: Json } {
  // Shallow clone, then deep-clone the path branches we'll mutate.
  const publicCfg: Json = { ...merged }
  const secrets: Json = {}
  for (const path of SENSITIVE_PATHS) {
    const value = getPath(merged, path)
    if (value === undefined) continue
    // Walk the path in the public side, cloning each layer we touch so
    // we don't mutate `merged`.
    const segs = path.split('.')
    let cur: Json = publicCfg
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i]
      const next = cur[k]
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        cur[k] = { ...(next as Json) }
        cur = cur[k] as Json
      } else {
        // Path doesn't exist on public side — nothing to move.
        cur = {}
        break
      }
    }
    deletePath(publicCfg, path)
    setPath(secrets, path, value)
  }
  return { publicCfg, secrets }
}

/** Overlay secrets on top of a public config. Used at load time. */
export function mergeSecrets<T extends Json>(publicCfg: T, secrets: Json): T {
  const out: Json = { ...publicCfg }
  for (const path of SENSITIVE_PATHS) {
    const value = getPath(secrets, path)
    if (value === undefined) continue
    setPath(out, path, value)
  }
  return out as T
}

/**
 * Diagnostic / migration aid. Returns the dotted paths in `config` that
 * are sensitive AND have a real value — i.e. the set that splitConfig
 * would route to secrets.json. Empty list means the config is already
 * secrets-free (either nothing sensitive configured, or migration done).
 */
export function listSensitivePathsInConfig(config: Json): string[] {
  return SENSITIVE_PATHS.filter((p) => {
    const v = getPath(config, p)
    return v !== undefined && v !== ''
  })
}
