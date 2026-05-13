// Pre-flight checks run BEFORE a restart is initiated.
//
// The whole point: catch "this would obviously fail to come back" before
// we kill the current process. Failing a check returns the list of
// errors; the caller (restart-flow.ts) refuses to restart and surfaces
// them to the user via IM. Service stays alive.
//
// Each check has a hard fail (errors -> refuse) and soft fail (warnings ->
// log, proceed). Warnings are surfaced in the completion message so the
// user knows about them after the new daemon comes up.

import { access, constants as fsConstants, stat, statfs } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { loadConfig } from './onboarding.js'
import { validateConfig } from './config-schema.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'restart-preflight' })

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Path to the compiled cli.js that the restart helper will respawn. */
const CLI_PATH = join(__dirname, '..', 'cli.js')

/** Minimum free space in AGIM_HOME for the new daemon to be likely able to
 *  log, write databases, etc. Generous floor so noisy logs don't surprise. */
const MIN_FREE_BYTES = 50 * 1024 * 1024  // 50 MiB

export interface PreflightResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export async function runPreflightChecks(): Promise<PreflightResult> {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Config schema validates.
  try {
    const cfg = await loadConfig()
    const res = validateConfig(cfg)
    if (!res.ok) {
      errors.push(`config.json 校验失败：${res.errors.join('; ')}`)
    }
  } catch (err) {
    errors.push(`config.json 读取失败：${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. AGIM_HOME writable.
  try {
    await access(AGIM_HOME, fsConstants.W_OK)
  } catch (err) {
    errors.push(`${AGIM_HOME} 不可写：${err instanceof Error ? err.message : String(err)}`)
  }

  // 3. Disk space.
  try {
    const s = await statfs(AGIM_HOME)
    const free = s.bavail * s.bsize
    if (free < MIN_FREE_BYTES) {
      errors.push(`${AGIM_HOME} 剩余空间 ${(free / 1024 / 1024).toFixed(0)} MiB，低于最小要求 50 MiB`)
    }
  } catch (err) {
    // statfs unavailable on some old platforms — warn but don't fail.
    warnings.push(`无法检查磁盘空间：${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. cli.js exists at the expected path (the restart helper will spawn
  //    this very file).
  if (!existsSync(CLI_PATH)) {
    errors.push(`dist 入口找不到：${CLI_PATH}（npm 安装未完成？）`)
  } else {
    try {
      const st = await stat(CLI_PATH)
      if (!st.isFile()) errors.push(`${CLI_PATH} 不是常规文件`)
    } catch { /* covered above */ }
  }

  // 5. Lock file from a previous in-progress restart? If yes, refuse.
  //    (concurrency guard is implemented as a file in restart-flow.ts,
  //    duplicated check here so pre-flight surfaces the friendly error
  //    without writing a new state file.)
  const pendingFile = join(AGIM_HOME, 'restart-pending.json')
  if (existsSync(pendingFile)) {
    try {
      const st = await stat(pendingFile)
      const ageSec = (Date.now() - st.mtimeMs) / 1000
      if (ageSec < 60) {
        errors.push(`60 秒内已有进行中的重启（${ageSec.toFixed(0)} 秒前发起）`)
      } else {
        warnings.push(`发现过期的 restart-pending.json（${ageSec.toFixed(0)} 秒前），将被覆盖`)
      }
    } catch { /* ignore */ }
  }

  const ok = errors.length === 0
  log.info({ event: 'preflight.result', ok, errors, warnings })
  return { ok, errors, warnings }
}
