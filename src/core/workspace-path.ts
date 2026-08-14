/**
 * Resolve a Portal workspace path the agent can actually open.
 *
 * The browser folder picker often only yields a folder name (not an
 * absolute path). If that name exists under process.cwd() or $HOME,
 * we bind the agent there. Absolute paths that exist on this host
 * are used as-is (after realpath + sensitive-path checks).
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import { isSensitivePath } from './sensitive-paths.js'

export function resolvePortalWorkspacePath(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('..')) return undefined

  const candidates = isAbsolute(trimmed)
    ? [trimmed]
    : [resolve(process.cwd(), trimmed), resolve(homedir(), trimmed)]

  for (const candidate of candidates) {
    const resolved = existingSafeDir(candidate)
    if (resolved) return resolved
  }
  return undefined
}

function existingSafeDir(p: string): string | undefined {
  try {
    const st = statSync(p)
    if (!st.isDirectory()) return undefined
    const real = realpathSync(p)
    if (isSensitivePath(real).sensitive) return undefined
    return real
  } catch {
    return undefined
  }
}
