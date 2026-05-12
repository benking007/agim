// cli-ui/env-file.ts — read / write key=value pairs in ~/.im-hub/env.
//
// The env file is sourced by the systemd unit (`EnvironmentFile=`) AND by
// `agim start --bg` via process.env when we re-exec ourselves. It's
// chmod 600 because it holds SMTP passwords and Baidu Maps AK.
//
// Format: simple `KEY=value` per line. No interpolation, no quoting required.
// Lines starting with # are preserved as comments. Empty lines preserved.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from '../core/agim-paths.js'

export const ENV_FILE = join(AGIM_HOME, 'env')

/** Read existing env as a plain Record. Unknown lines (blank / comment)
 *  are dropped from the returned map but PRESERVED on write via merge. */
export function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {}
  const result: Record<string, string> = {}
  try {
    const raw = readFileSync(ENV_FILE, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1)
      result[key] = val
    }
  } catch { /* return what we have */ }
  return result
}

/** Keys the wizard prefills. `readEffectiveEnv()` checks the env file
 *  first, then falls back to `process.env` for these — so SMTP/Baidu set
 *  via the systemd unit's `Environment=` lines (the install pattern used
 *  before the wizard existed) still appear in the prefill UI. */
const WIZARD_ENV_KEYS = [
  'IMHUB_SMTP_HOST',
  'IMHUB_SMTP_PORT',
  'IMHUB_SMTP_USER',
  'IMHUB_SMTP_PASS',
  'IMHUB_SMTP_FROM',
  'IMHUB_SMTP_SECURE',
  'IMHUB_BAIDU_MAP_AK',
] as const

const SYSTEMD_UNIT_PATH = '/etc/systemd/system/im-hub.service'

/** Parse `Environment="KEY=value"` and `Environment=KEY=value` lines out
 *  of the im-hub systemd unit. Used as a fallback for `readEffectiveEnv()`
 *  on machines where the wizard hasn't yet written to ~/.im-hub/env AND
 *  the user's interactive shell doesn't export the keys — the unit file
 *  is world-readable on standard installs, so this works for `agim
 *  config` invoked as the user. Returns {} if the file is missing/unreadable. */
export function readSystemdUnitEnv(): Record<string, string> {
  if (!existsSync(SYSTEMD_UNIT_PATH)) return {}
  const result: Record<string, string> = {}
  try {
    const raw = readFileSync(SYSTEMD_UNIT_PATH, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('Environment')) continue
      // Strip leading `Environment=` (with optional whitespace after =).
      const rhs = trimmed.replace(/^Environment\s*=\s*/, '')
      // Unit lines can be `Environment="K=V"` or `Environment=K=V` or
      // even `Environment="K1=V1" "K2=V2"`. systemd doesn't support
      // multi-line values via continuation that we care about here.
      // Split on whitespace OUTSIDE quotes, then strip the surrounding
      // quotes if present.
      const tokens = rhs.match(/"[^"]*"|\S+/g) ?? []
      for (const tok of tokens) {
        const unq = tok.startsWith('"') && tok.endsWith('"') ? tok.slice(1, -1) : tok
        const eq = unq.indexOf('=')
        if (eq <= 0) continue
        const key = unq.slice(0, eq)
        const val = unq.slice(eq + 1)
        if (key) result[key] = val
      }
    }
  } catch { /* permissions / parse error — best-effort */ }
  return result
}

/** Read priority:
 *    1. ~/.im-hub/env  (canonical, what the wizard writes)
 *    2. process.env     (current shell / inherited)
 *    3. systemd unit's Environment= lines (what's actually in effect for
 *       the running service when the wizard is invoked from a shell that
 *       doesn't export the keys — most common case after a manual install)
 *
 *  Writes still go to the env file only — see `updateEnvFile()`. Callers
 *  that need to warn about shadowing should use `hasProcessEnvOverride()`. */
export function readEffectiveEnv(): Record<string, string> {
  const fromFile = readEnvFile()
  const fromUnit = readSystemdUnitEnv()
  const merged: Record<string, string> = { ...fromFile }
  for (const k of WIZARD_ENV_KEYS) {
    if (merged[k] !== undefined) continue
    if (typeof process.env[k] === 'string' && process.env[k] !== '') {
      merged[k] = process.env[k] as string
      continue
    }
    if (typeof fromUnit[k] === 'string' && fromUnit[k] !== '') {
      merged[k] = fromUnit[k]
    }
  }
  return merged
}

/** True when a wizard-managed key is set in the running env (process.env
 *  or systemd unit) but NOT in the env file — i.e. the wizard's writes
 *  won't be the source of truth at runtime. Used to print a warning at
 *  SMTP/Baidu save. */
export function hasProcessEnvOverride(key: string): boolean {
  const file = readEnvFile()
  if (file[key] !== undefined) return false
  if (typeof process.env[key] === 'string' && process.env[key] !== '') return true
  const unit = readSystemdUnitEnv()
  return typeof unit[key] === 'string' && unit[key] !== ''
}

/** Merge-update: keep existing keys, overwrite the supplied ones, REMOVE
 *  any keys whose value in `updates` is explicitly null/undefined. Writes
 *  the file with chmod 600. */
export function updateEnvFile(updates: Record<string, string | null | undefined>): void {
  const current = readEnvFile()
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === undefined) delete current[k]
    else current[k] = v
  }
  mkdirSync(dirname(ENV_FILE), { recursive: true })
  const lines = Object.entries(current).map(([k, v]) => `${k}=${v}`)
  writeFileSync(ENV_FILE, lines.join('\n') + (lines.length ? '\n' : ''))
  chmodSync(ENV_FILE, 0o600)
}

/** Wipe a single key. No-op if missing. */
export function unsetEnvKey(key: string): void {
  if (!existsSync(ENV_FILE)) return
  const current = readEnvFile()
  if (!(key in current)) return
  delete current[key]
  const lines = Object.entries(current).map(([k, v]) => `${k}=${v}`)
  writeFileSync(ENV_FILE, lines.join('\n') + (lines.length ? '\n' : ''))
  chmodSync(ENV_FILE, 0o600)
}

/** Remove the env file entirely. Used by `uninstall`. */
export function removeEnvFile(): void {
  try { unlinkSync(ENV_FILE) } catch { /* already gone */ }
}
