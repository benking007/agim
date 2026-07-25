import { readFileSync } from 'node:fs'
import { logger as rootLogger } from '../logger.js'
import { CONFIG_FILE } from '../config-store.js'
import { isSenderAllowlistStrict } from '../sender-allowlist.js'

const log = rootLogger.child({ component: 'approval-bus' })

// AGIM_AUTO_APPROVE — first-class auto-approve switch (default OFF).
// When enabled, tool calls are approved immediately after safety checks
// (sensitive-path hard-deny + self-protect), without sending an IM
// approval card or waiting for any timeout. The approval bus still runs
// so audit trail, metrics, and safety checks all remain active.
//
// Safe default is OFF: open IM + auto-approve is a remote command surface.
// Opt in with AGIM_AUTO_APPROVE=1. When IM messengers are configured and
// AGIM_ALLOWED_USERS is not a strict platform:userId list, auto-approve
// is suppressed unless AGIM_AUTO_APPROVE_OPEN_IM=1 (explicit ack).
//
// Read per call (not cached at module load) so the Web Settings panel
// can hot-toggle it via handlePutEnv.
export function isAutoApproveEnabled(): boolean {
  const raw = (process.env.AGIM_AUTO_APPROVE ?? '0').toLowerCase().trim()
  return raw !== '0' && raw !== 'off' && raw !== 'false' && raw !== 'no' && raw !== ''
}

/** True when auto-approve may actually fire (env on AND open-IM gate OK). */
export function isAutoApproveEffective(): boolean {
  if (!isAutoApproveEnabled()) return false
  if ((process.env.AGIM_AUTO_APPROVE_OPEN_IM || '').trim() === '1') return true
  if (isSenderAllowlistStrict()) return true
  // Web-console-only (no IM messengers) may keep auto-approve without
  // a sender allowlist — tokens already gate the control plane.
  if (!hasConfiguredImMessengersSync()) return true
  return false
}

/**
 * Hot-apply composer / Settings「替我审批」.
 *
 * Turning ON also sets `AGIM_AUTO_APPROVE_OPEN_IM=1` — the UI toggle is the
 * explicit open-IM acknowledgement. Without that ack, `isAutoApproveEnabled`
 * can be true while `isAutoApproveEffective` stays false (IM messengers
 * configured, no strict allowlist), and Portal still gets approval cards
 * (incl. unconfined goal `agim_exec` countdown). Turning OFF clears both.
 */
export function applyAutoApprovePolicy(enabled: boolean): {
  enabled: boolean
  effective: boolean
} {
  const value = enabled ? '1' : '0'
  process.env.AGIM_AUTO_APPROVE = value
  process.env.AGIM_AUTO_APPROVE_OPEN_IM = value
  return {
    enabled: isAutoApproveEnabled(),
    effective: isAutoApproveEffective(),
  }
}

function hasConfiguredImMessengersSync(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as { messengers?: unknown }
    return Array.isArray(parsed.messengers) && parsed.messengers.length > 0
  } catch {
    return false
  }
}

// AGIM_APPROVAL_ON_TIMEOUT=allow | deny (default allow). Legacy alias:
// AGIM_TIMEOUT_DEFAULT. Decides what the bus returns when a pending
// approval times out without a human response. Only relevant when
// AGIM_AUTO_APPROVE is off (otherwise tools never reach the timeout
// path). Default 'allow' auto-approves on timeout; set 'deny' for
// strict interactive mode.
//
// Read at every timer fire (not captured at module load) so the Web
// Settings card can hot-toggle it.
export function isTimeoutDefaultAllow(): boolean {
  // Canonical: AGIM_APPROVAL_ON_TIMEOUT. Legacy: AGIM_TIMEOUT_DEFAULT.
  // Both accept allow|deny; default allow. Read at every timer fire so
  // the Web Settings card can hot-toggle without restart.
  const raw = (
    process.env.AGIM_APPROVAL_ON_TIMEOUT
    ?? process.env.AGIM_TIMEOUT_DEFAULT
    ?? 'allow'
  ).toLowerCase()
  return raw !== 'deny'
}

// R13 C1 — visibility for "user away" mode. When AGIM_APPROVAL_ON_TIMEOUT
// (legacy AGIM_TIMEOUT_DEFAULT) is `allow`, every approval that times out
// without IM response auto-approves — that's a meaningful weakening of the
// human-in-the-loop guarantee.
let _timeoutAllowHourlyTimer: ReturnType<typeof setInterval> | null = null

export function announceTimeoutDefaultIfAllow(): void {
  // Log auto-approve status at startup. Enabled is now opt-in and gets a
  // loud banner — especially when IM is open without a strict allowlist.
  if (isAutoApproveEnabled()) {
    const effective = isAutoApproveEffective()
    const banner = [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      effective
        ? '⚠️  AGIM_AUTO_APPROVE=1 — tool calls auto-approved after safety checks'
        : '⚠️  AGIM_AUTO_APPROVE=1 but SUPPRESSED (open IM without strict allowlist)',
      '',
      effective
        ? '   Mutating tools skip IM approval cards. For untrusted IM set AGIM_AUTO_APPROVE=0.'
        : '   IM messengers are configured and AGIM_ALLOWED_USERS is not a strict',
      effective
        ? '   Or lock senders: AGIM_ALLOWED_USERS=platform:userId,...'
        : '   platform:userId list — auto-approve will not fire. Fix with either:',
      ...(effective
        ? []
        : [
          '     • AGIM_ALLOWED_USERS=telegram:123,...   (recommended)',
          '     • AGIM_AUTO_APPROVE_OPEN_IM=1           (explicit open-IM ack)',
        ]),
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ].join('\n')
    process.stdout.write(banner)
    log.warn({
      event: effective
        ? 'approval.bus.auto_approve_enabled'
        : 'approval.bus.auto_approve_suppressed_open_im',
      effective,
    }, effective
      ? 'AGIM_AUTO_APPROVE=on — tool calls auto-approved after safety checks'
      : 'AGIM_AUTO_APPROVE=on but suppressed — open IM without strict allowlist')
    if (_timeoutAllowHourlyTimer) {
      clearInterval(_timeoutAllowHourlyTimer)
      _timeoutAllowHourlyTimer = null
    }
    return
  }

  if (!isTimeoutDefaultAllow()) {
    if (_timeoutAllowHourlyTimer) {
      clearInterval(_timeoutAllowHourlyTimer)
      _timeoutAllowHourlyTimer = null
    }
    return
  }
  const banner = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '⚠️  APPROVAL TIMEOUT POLICY: allow',
    '',
    '   AGIM_APPROVAL_ON_TIMEOUT=allow → unresolved approvals auto-approve.',
    '   Human-in-the-loop oversight on Bash / Edit / Write is weakened.',
    '   Revert with: AGIM_APPROVAL_ON_TIMEOUT=deny.',
    '   Or set AGIM_AUTO_APPROVE=1 only after locking AGIM_ALLOWED_USERS.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ].join('\n')
  process.stdout.write(banner)
  log.warn({
    event: 'approval.bus.timeout_default_allow',
    msg: 'AGIM_APPROVAL_ON_TIMEOUT=allow — approval timeouts auto-approve',
  })
  try {
    void (async () => {
      const { logAuditEvent } = await import('../audit-log.js')
      logAuditEvent({
        eventType: 'config.put',
        actor: 'system',
        target: 'approval.timeout_default',
        outcome: 'ok',
        details: { value: 'allow', startup: true },
      })
    })()
  } catch { /* best-effort */ }
  if (_timeoutAllowHourlyTimer === null) {
    _timeoutAllowHourlyTimer = setInterval(() => {
      if (!isTimeoutDefaultAllow()) {
        if (_timeoutAllowHourlyTimer) {
          clearInterval(_timeoutAllowHourlyTimer)
          _timeoutAllowHourlyTimer = null
        }
        return
      }
      log.warn({
        event: 'approval.bus.timeout_default_allow.reminder',
        msg: 'reminder: AGIM_APPROVAL_ON_TIMEOUT=allow still in effect',
      })
    }, 60 * 60 * 1000)
    if (typeof _timeoutAllowHourlyTimer === 'object' && _timeoutAllowHourlyTimer
        && 'unref' in _timeoutAllowHourlyTimer) {
      (_timeoutAllowHourlyTimer as { unref: () => void }).unref()
    }
  }
}

/** Stop the C1 hourly reminder. Used by graceful shutdown + tests. */
export function stopTimeoutDefaultReminder(): void {
  if (_timeoutAllowHourlyTimer) {
    clearInterval(_timeoutAllowHourlyTimer)
    _timeoutAllowHourlyTimer = null
  }
}

/**
 * Tools whose contract is "read filesystem state, return it" — no writes,
 * no shell exec, no network. These short-circuit the approval flow with an
 * immediate `allow` and never reach the IM notifier. Saves the ~3–5s round
 * trip per call AND removes the noise of "🔐 Read /tmp/foo.txt y/n" cards
 * that LLMs spam during exploration.
 *
 * Conservative starting list — only tools whose name guarantees the
 * contract. Excluded on purpose:
 *  - `Bash` (cannot statically tell `cat` from `rm -rf /`)
 *  - `WebFetch` / `WebSearch` (outbound HTTP — leaks context, hits rate
 *    limits, has third-party side effects even if "readonly" locally)
 *  - any `mcp__*` (third-party MCP servers; arbitrary semantics)
 *
 * Per-thread opt-out: `/approval readonly off`. Global opt-out:
 * `AGIM_AUTOALLOW_READONLY=0`.
 */
export const READONLY_TOOLS = new Set<string>([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
])

export const READONLY_AUTO_ALLOW_GLOBAL_ENABLED =
  (process.env.AGIM_AUTOALLOW_READONLY ?? '1') !== '0'
