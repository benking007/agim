// cli-ui/env-file.ts — read / write key=value pairs in ~/.im-hub/env.
//
// The env file is sourced by the systemd unit (`EnvironmentFile=`) AND by
// `im-hub-pro start --bg` via process.env when we re-exec ourselves. It's
// chmod 600 because it holds SMTP passwords and Baidu Maps AK.
//
// Format: simple `KEY=value` per line. No interpolation, no quoting required.
// Lines starting with # are preserved as comments. Empty lines preserved.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const ENV_FILE = join(homedir(), '.im-hub', 'env')

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
