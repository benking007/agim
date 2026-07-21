// Install the shipped bgjob wrapper (+ agim_rpc.py) into ~/.agim/scripts/
// and ensure ~/.agim/bgjobs/ exists. Called from `agim start` bootstrap so
// Agim Agent's long-task SOP has a real absolute path to invoke.

import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'bgjob-install' })

/** Absolute path of the installed wrapper (what agents should exec). */
export function agimBgjobScript(home = AGIM_HOME): string {
  return join(home, 'scripts', 'bgjob')
}

/** Absolute path of the default job data root. */
export function agimBgjobsDir(home = AGIM_HOME): string {
  return process.env.AGIM_BGJOBS?.trim()
    || join(home, 'bgjobs')
}

/** Known absolute wrapper paths that may receive the bwrap carve-out.
 *  Prefer the Agim-owned install; keep legacy Claude/opencode paths so
 *  existing operators are not broken. */
export function bgjobAllowedPaths(): string[] {
  const home = process.env.AGIM_HOME?.trim() || AGIM_HOME || join(homedir(), '.agim')
  const user = homedir()
  return [
    agimBgjobScript(home),
    join(user, '.claude', 'scripts', 'bgjob'),
    join(user, '.config', 'opencode', 'scripts', 'bgjob'),
  ]
}

function resolvePackagedScript(name: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // dist/core/bgjob-install.js → <pkg>/bin/<name>
    join(here, '..', '..', 'bin', name),
    // running from src/ via bun/tsx
    join(here, '..', '..', '..', 'bin', name),
    join(process.cwd(), 'bin', name),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function installOne(src: string, dest: string, mode: number): boolean {
  try {
    mkdirSync(dirname(dest), { recursive: true })
    let needsCopy = true
    if (existsSync(dest)) {
      try {
        const a = readFileSync(src)
        const b = readFileSync(dest)
        needsCopy = a.length !== b.length || !a.equals(b)
      } catch {
        needsCopy = true
      }
    }
    if (needsCopy) copyFileSync(src, dest)
    chmodSync(dest, mode)
    return true
  } catch (err) {
    log.warn({
      event: 'bgjob.install_failed',
      src,
      dest,
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to install bgjob helper script')
    return false
  }
}

/**
 * Idempotent: copy packaged `bin/bgjob` + `bin/agim_rpc.py` into
 * `~/.agim/scripts/` and ensure the bgjobs data directory exists.
 * Returns the installed wrapper path when successful, else null.
 */
export function ensureBgjobInstalled(home = AGIM_HOME): string | null {
  const srcBgjob = resolvePackagedScript('bgjob')
  if (!srcBgjob) {
    log.warn({ event: 'bgjob.packaged_missing' }, 'packaged bin/bgjob not found; skip install')
    return existsSync(agimBgjobScript(home)) ? agimBgjobScript(home) : null
  }
  const destBgjob = agimBgjobScript(home)
  const ok = installOne(srcBgjob, destBgjob, 0o755)
  const srcRpc = resolvePackagedScript('agim_rpc.py')
  if (srcRpc) {
    installOne(srcRpc, join(home, 'scripts', 'agim_rpc.py'), 0o644)
  }
  try {
    mkdirSync(agimBgjobsDir(home), { recursive: true })
  } catch (err) {
    log.warn({
      event: 'bgjob.mkdir_failed',
      dir: agimBgjobsDir(home),
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to create bgjobs data dir')
  }
  return ok || existsSync(destBgjob) ? destBgjob : null
}
