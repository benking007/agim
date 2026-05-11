// cli-ui/service.ts — cross-platform service detection + lifecycle for
// im-hub-pro. Knows about three run modes:
//
//   1. systemd-managed   — Linux + root, /etc/systemd/system/im-hub.service
//                          exists and `systemctl is-active im-hub.service`
//                          returns "active". The installer creates the
//                          unit when run as root.
//   2. background daemon — `im-hub-pro start --bg` writes ~/.im-hub/im-hub.pid
//                          and ~/.im-hub/im-hub.log. nohup + setsid; survives
//                          shell exit. Works on Linux, macOS, WSL2.
//   3. foreground        — a TTY-attached `im-hub-pro start` somewhere. We
//                          detect it via `pgrep -af` matching, but can't
//                          stop or restart it from outside the owning TTY.
//
// The detection helpers are all best-effort: a missing systemctl, a stale
// pid file, or a pgrep mismatch produces "not running" rather than an
// error, so the caller can decide what to ack.

import { execSync, spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const PID_FILE = join(homedir(), '.im-hub', 'im-hub.pid')
export const LOG_FILE = join(homedir(), '.im-hub', 'im-hub.log')
const SYSTEMD_UNIT = '/etc/systemd/system/im-hub.service'

export type ServiceMode = 'systemd' | 'background' | 'foreground' | 'none'

export interface ServiceState {
  mode: ServiceMode
  pid: number | null
  /** Approximate uptime in seconds — from systemd timestamp or proc start time. */
  uptimeSec?: number
}

/** Check if a unix pid is alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch { return false }
}

/** Approximate uptime by reading /proc/<pid>/stat — Linux/WSL only.
 *  On macOS we'd need `ps -o etime`; not bothering for status display. */
function uptimeOfPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // Field 22 (0-indexed 21) is start time in clock ticks since boot.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const starttimeTicks = parseInt(fields[19], 10)
    if (!Number.isFinite(starttimeTicks)) return undefined
    const ticksPerSec = parseInt(execSync('getconf CLK_TCK').toString().trim(), 10) || 100
    const bootTime = parseInt(execSync(`awk '/btime/ {print $2}' /proc/stat`).toString().trim(), 10)
    if (!Number.isFinite(bootTime)) return undefined
    const startUnix = bootTime + starttimeTicks / ticksPerSec
    return Math.max(0, Math.floor(Date.now() / 1000 - startUnix))
  } catch { return undefined }
}

/** Format seconds as e.g. "2h 15m" / "3d 4h" / "45s". */
export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Look up the running mode + pid. Order matters: systemd wins, then bg
 *  pid-file, then a foreground pgrep match. Returns `{mode:'none', pid:null}`
 *  when nothing is running. */
export function detectService(): ServiceState {
  // 1. systemd
  if (existsSync(SYSTEMD_UNIT)) {
    try {
      const active = execSync('systemctl is-active im-hub.service 2>&1', { encoding: 'utf-8' }).trim()
      if (active === 'active') {
        let pid: number | null = null
        try {
          const out = execSync('systemctl show -p MainPID --value im-hub.service', { encoding: 'utf-8' }).trim()
          const n = parseInt(out, 10)
          if (Number.isFinite(n) && n > 0) pid = n
        } catch { /* keep null */ }
        return {
          mode: 'systemd',
          pid,
          uptimeSec: pid ? uptimeOfPid(pid) : undefined,
        }
      }
    } catch { /* systemctl not on PATH, e.g. macOS — fall through */ }
  }

  // 2. background pid file
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
      if (Number.isFinite(pid) && pidAlive(pid)) {
        return { mode: 'background', pid, uptimeSec: uptimeOfPid(pid) }
      }
    } catch { /* fall through */ }
  }

  // 3. foreground — pgrep for our CLI. Match `im-hub-pro start` or
  //    `dist/cli.js start`. Excludes the current process (the CLI that's
  //    running this check).
  try {
    const out = execSync('pgrep -af "im-hub-pro start|dist/cli.js start"', {
      encoding: 'utf-8',
    }).trim()
    const lines = out.split('\n').filter(Boolean)
    for (const line of lines) {
      const pid = parseInt(line.split(' ')[0], 10)
      if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) {
        return { mode: 'foreground', pid, uptimeSec: uptimeOfPid(pid) }
      }
    }
  } catch { /* pgrep found nothing — exit 1 */ }

  return { mode: 'none', pid: null }
}

/**
 * Spawn im-hub-pro detached with stdio redirected to ~/.im-hub/im-hub.log.
 * Writes the pid to PID_FILE so subsequent `status` / `stop` find it.
 *
 * Cross-platform: setsid → new session, no controlling tty, parent can exit.
 * On macOS where setsid isn't always reliable, fall through to a plain
 * detached spawn (child still gets stdio: 'ignore' / 'pipe' redirected to
 * the log file, which is enough to survive the parent).
 */
export function spawnBackground(executable: string, args: string[] = ['start']): { pid: number } {
  mkdirSync(dirname(LOG_FILE), { recursive: true })
  // Open the log file (append) and use its fd for child stdout/stderr.
  // openSync + closeSync are statically imported at the top — require() doesn't
  // exist in ESM modules (package.json has "type": "module").
  const fd = openSync(LOG_FILE, 'a')
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: process.env,
    })
    child.unref()
    if (!child.pid) throw new Error('spawn returned no pid')
    writeFileSync(PID_FILE, `${child.pid}\n`)
    return { pid: child.pid }
  } finally {
    closeSync(fd)
  }
}

/** Stop whichever instance is running. Returns the mode that was stopped
 *  (or 'none' when there was nothing to do). */
export async function stopService(): Promise<{ mode: ServiceMode; pid: number | null }> {
  const st = detectService()
  if (st.mode === 'none') return { mode: 'none', pid: null }

  if (st.mode === 'systemd') {
    execSync('systemctl stop im-hub.service', { stdio: 'inherit' })
    return { mode: 'systemd', pid: st.pid }
  }

  if (st.mode === 'background' && st.pid) {
    try { process.kill(st.pid, 'SIGTERM') } catch { /* already gone */ }
    // Wait up to 5s for clean exit, then SIGKILL.
    for (let i = 0; i < 50; i++) {
      if (!pidAlive(st.pid)) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (pidAlive(st.pid)) {
      try { process.kill(st.pid, 'SIGKILL') } catch { /* ignore */ }
    }
    try { unlinkSync(PID_FILE) } catch { /* ok if already gone */ }
    return { mode: 'background', pid: st.pid }
  }

  if (st.mode === 'foreground' && st.pid) {
    // Best-effort: try SIGTERM. The owning TTY may also see Ctrl-C.
    try { process.kill(st.pid, 'SIGTERM') } catch { /* ignore */ }
    return { mode: 'foreground', pid: st.pid }
  }

  return { mode: 'none', pid: null }
}

/** Get the configured web bind+port from ~/.im-hub/config.json — used by
 *  `status` to print the URL. Returns null when config is absent / unparseable. */
export function readWebEndpoint(): { bind: string; port: number } | null {
  try {
    const raw = readFileSync(join(homedir(), '.im-hub', 'config.json'), 'utf-8')
    const cfg = JSON.parse(raw) as { web?: { bind?: string; port?: number } }
    const bind = typeof cfg.web?.bind === 'string' ? cfg.web.bind : '127.0.0.1'
    const port = typeof cfg.web?.port === 'number' ? cfg.web.port : 3000
    return { bind, port }
  } catch { return null }
}
