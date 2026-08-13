// Shared native execution-world flags (fs + exec).
//
// DeepSeek Harness lesson: filesystem and subprocess share one confinement
// world. Agim keeps two env knobs, but writes follow the exec sandbox unless
// the operator explicitly unconfines FS (`AGIM_NATIVE_FS_RESTRICT=0`).

import { existsSync } from 'node:fs'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ component: 'execution-world' })

export interface ExecutionWorldProbe {
  /** Override `/usr/bin/bwrap` detection (tests). */
  bwrapPresent?: boolean
}

/** True when Linux bubblewrap will wrap `agim_exec` (default-on if installed). */
export function isExecSandboxConfigured(probe: ExecutionWorldProbe = {}): boolean {
  const mode = (process.env.AGIM_EXEC_SANDBOX || '').toLowerCase()
  if (mode === 'off') return false
  const present = probe.bwrapPresent ?? existsSync('/usr/bin/bwrap')
  return present
}

/** Read/list/grep confinement — opt-in (`AGIM_NATIVE_FS_RESTRICT=1`). */
export function isNativeFsReadRestricted(): boolean {
  return process.env.AGIM_NATIVE_FS_RESTRICT === '1'
}

/**
 * Write confinement. `=1` always confines. `=0` always unconfines (loud when
 * the exec sandbox is on). Unset follows the exec sandbox so bwrap cannot be
 * sidestepped with `agim_write_file`.
 */
export function isNativeFsWriteRestricted(probe: ExecutionWorldProbe = {}): boolean {
  const raw = process.env.AGIM_NATIVE_FS_RESTRICT
  if (raw === '1') return true
  if (raw === '0') return false
  return isExecSandboxConfigured(probe)
}

let warnedWriteUnconfined = false

/** One-shot warning: exec sandbox on, but writes were explicitly unconfined. */
export function warnWriteUnconfinedIfSandbox(probe: ExecutionWorldProbe = {}): void {
  if (warnedWriteUnconfined) return
  if (process.env.AGIM_NATIVE_FS_RESTRICT !== '0') return
  if (!isExecSandboxConfigured(probe)) return
  warnedWriteUnconfined = true
  log.warn(
    { event: 'fs.write_unconfined_with_exec_sandbox' },
    'AGIM_NATIVE_FS_RESTRICT=0: agim_write_file can mutate host paths outside the workspace while agim_exec is sandboxed. Set AGIM_NATIVE_FS_RESTRICT=1 (or unset) so writes follow the exec sandbox.',
  )
}

/** Test-only: reset the one-shot warning latch. */
export function _resetExecutionWorldWarningsForTests(): void {
  warnedWriteUnconfined = false
}
