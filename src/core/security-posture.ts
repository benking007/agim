// Operator-visible security posture at `agim start`.
//
// Settings already expose these knobs, but a boot-time banner is the
// fail-loud counterpart: an unconfined exec sandbox or open FS is easy
// to miss until something writes outside the workspace.

import { existsSync } from 'node:fs'
import { logger as rootLogger } from './logger.js'
import { isAutoApproveEffective, isAutoApproveEnabled } from './approval/policy.js'

const log = rootLogger.child({ component: 'security-posture' })

export type ExecSandboxPosture = 'bwrap' | 'off' | 'unavailable'

export interface SecurityPosture {
  bwrapAvailable: boolean
  execSandbox: ExecSandboxPosture
  /** True when AGIM_NATIVE_FS_RESTRICT=1 (workspace-confined native FS). */
  fsRestrict: boolean
  /** Explicit AGIM_NATIVE_FS_RESTRICT=0 (unconfine even if a later default follows exec sandbox). */
  fsUnconfineExplicit: boolean
  autoApprove: boolean
  autoApproveEffective: boolean
}

export function getSecurityPosture(): SecurityPosture {
  const bwrapAvailable = existsSync('/usr/bin/bwrap')
  const sandboxMode = (process.env.AGIM_EXEC_SANDBOX || '').toLowerCase().trim()
  let execSandbox: ExecSandboxPosture
  if (!bwrapAvailable) execSandbox = 'unavailable'
  else if (sandboxMode === 'off') execSandbox = 'off'
  else execSandbox = 'bwrap'

  const fsRaw = (process.env.AGIM_NATIVE_FS_RESTRICT ?? '').trim()
  return {
    bwrapAvailable,
    execSandbox,
    fsRestrict: fsRaw === '1',
    fsUnconfineExplicit: fsRaw === '0',
    autoApprove: isAutoApproveEnabled(),
    autoApproveEffective: isAutoApproveEffective(),
  }
}

export function formatSecurityPostureLines(p: SecurityPosture = getSecurityPosture()): string[] {
  const execLine = p.execSandbox === 'bwrap'
    ? 'exec sandbox: bwrap (on)'
    : p.execSandbox === 'off'
      ? 'exec sandbox: OFF (bwrap installed but AGIM_EXEC_SANDBOX=off — unconfined)'
      : 'exec sandbox: unavailable (no /usr/bin/bwrap — agim_exec is unconfined)'
  const fsLine = p.fsRestrict
    ? 'native FS: restricted to workspace (AGIM_NATIVE_FS_RESTRICT=1)'
    : p.fsUnconfineExplicit
      ? 'native FS: EXPLICITLY unconfined (AGIM_NATIVE_FS_RESTRICT=0)'
      : 'native FS: unrestricted (unset — reads/writes may leave the workspace)'
  const approveLine = !p.autoApprove
    ? 'auto-approve: off'
    : p.autoApproveEffective
      ? 'auto-approve: ON (effective)'
      : 'auto-approve: on but suppressed (open IM / no strict allowlist)'
  return [execLine, fsLine, approveLine]
}

/** Loud boot banner + structured log. Safe to call more than once. */
export function announceSecurityPosture(): void {
  const p = getSecurityPosture()
  const lines = formatSecurityPostureLines(p)
  const warn = p.execSandbox !== 'bwrap' || !p.fsRestrict || (p.autoApprove && p.autoApproveEffective)
  const banner = [
    '',
    '── Agim security posture ─────────────────────────────────────',
    ...lines.map((l) => `   ${l}`),
    '──────────────────────────────────────────────────────────────',
    '',
  ].join('\n')
  if (warn) process.stderr.write(banner)
  else process.stdout.write(banner)
  log[warn ? 'warn' : 'info']({
    event: 'security.posture',
    ...p,
  }, lines.join('; '))
}
