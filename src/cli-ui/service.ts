// cli-ui/service.ts — cross-platform service detection + lifecycle for
// Agim. Knows about three run modes:
//
//   1. systemd-managed   — Linux + root, /etc/systemd/system/agim.service
//                          exists and systemd reports it as enabled.
//   2. background daemon — `agim start --bg` writes ~/.agim/agim.pid
//                          and ~/.agim/agim.log.
//                          nohup + setsid; survives shell exit. Works on
//                          Linux, macOS, WSL2.
//   3. foreground        — a TTY-attached `agim start` somewhere. We detect
//                          it via `pgrep -af` matching, but can't stop or
//                          restart it from outside the owning TTY.
//
// The detection helpers are all best-effort: a missing systemctl, a stale
// pid file, or a pgrep mismatch produces "not running" rather than an
// error, so the caller can decide what to ack.

import { execFileSync, execSync, spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, readdirSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join, dirname, basename } from 'node:path'
import { AGIM_HOME } from '../core/agim-paths.js'
import { readEnvFile } from './env-file.js'

// Pid + log files live inside AGIM_HOME.
export const PID_FILE = join(AGIM_HOME, 'agim.pid')
export const LOG_FILE = join(AGIM_HOME, 'agim.log')
export const DEFAULT_WEB_PORT = 3000
export const DEFAULT_ACP_PORT = 9090

/** Systemd unit candidates, checked in order. */
const SYSTEMD_UNIT_CANDIDATES = [
  '/etc/systemd/system/agim.service',
] as const

function getSystemdUnit(): { path: string; name: string } | null {
  for (const path of SYSTEMD_UNIT_CANDIDATES) {
    if (existsSync(path)) {
      // e.g. "/etc/systemd/system/agim.service" → "agim.service"
      return { path, name: path.split('/').pop() ?? '' }
    }
  }
  return null
}

export type ServiceMode = 'systemd' | 'background' | 'foreground' | 'none'

export interface ServiceState {
  mode: ServiceMode
  pid: number | null
  /** Approximate uptime in seconds — from systemd timestamp or proc start time. */
  uptimeSec?: number
  /** Raw `systemctl is-active` value when mode === 'systemd'. R14 — we
   *  return mode='systemd' as soon as the unit is enabled, even when
   *  state is `activating` / `failed` / `inactive`, so callers that
   *  care about the difference can inspect this field. Undefined for
   *  other modes. */
  active?: string
}

export interface TcpEndpoint {
  bind: string
  port: number
}

export interface TcpPortCheck extends TcpEndpoint {
  available: boolean
  code?: string
  owner?: string
}

let detectServiceOverride: (() => ServiceState) | null = null

export const _internal = {
  setDetectServiceOverride(fn: (() => ServiceState) | null): void {
    detectServiceOverride = fn
  },
}

function readConfigObject(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(AGIM_HOME, 'config.json'), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch { return null }
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
  if (detectServiceOverride) return detectServiceOverride()

  // 1. systemd — R14: authority test is "unit file exists AND is
  //    enabled", NOT "currently active". The old check returned
  //    mode='background' during the activating-auto-restart loop or
  //    after a failed start, which then made web restart fall back to
  //    spawnBackground — bypassing systemd entirely and producing two
  //    competing instances (the EADDRINUSE failure mode that
  //    motivated R14). When systemd owns the unit, every stop / start
  //    / restart MUST route through systemctl so systemd is the only
  //    converger.
  const unit = getSystemdUnit()
  if (unit) {
    try {
      const enabled = execSync(`systemctl is-enabled ${unit.name} 2>/dev/null`, { encoding: 'utf-8' }).trim()
      if (enabled === 'enabled' || enabled === 'static' || enabled === 'alias') {
        let pid: number | null = null
        let active = 'unknown'
        try {
          active = execSync(`systemctl is-active ${unit.name} 2>&1`, { encoding: 'utf-8' }).trim() || 'unknown'
        } catch (err) {
          // systemctl is-active exits non-zero when inactive — keep
          // the captured stderr as the state. execSync attaches the
          // failed-process output to err.stdout / err.stderr.
          const stdout = (err as { stdout?: Buffer }).stdout
          if (stdout) active = String(stdout).trim() || 'inactive'
          else active = 'inactive'
        }
        try {
          const out = execSync(`systemctl show -p MainPID --value ${unit.name}`, { encoding: 'utf-8' }).trim()
          const n = parseInt(out, 10)
          if (Number.isFinite(n) && n > 0) pid = n
        } catch { /* keep null — systemd may be between states */ }
        return {
          mode: 'systemd',
          pid,
          uptimeSec: pid ? uptimeOfPid(pid) : undefined,
          active,
        }
      }
    } catch { /* systemctl not on PATH (macOS) / is-enabled failed — fall through */ }
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

  // 3. foreground — strict argv-shape scan for a TTY-attached CLI.
  //    Excludes the current process (the CLI that's running this check).
  for (const pid of findAgimProcesses()) {
    if (pid !== process.pid && pidAlive(pid)) {
      return { mode: 'foreground', pid, uptimeSec: uptimeOfPid(pid) }
    }
  }

  return { mode: 'none', pid: null }
}

/**
 * Spawn Agim detached with stdio redirected to ~/.agim/agim.log.
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
    const unit = getSystemdUnit()
    if (unit) {
      execSync(`systemctl stop ${unit.name}`, { stdio: 'inherit' })
    }
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

/** Get the configured web bind+port from `<AGIM_HOME>/config.json` —
 *  used by `status` to print the URL. Returns null when config is
 *  absent / unparseable. */
export function readWebEndpoint(): { bind: string; port: number } | null {
  try {
    const cfg = readConfigObject() as { web?: { bind?: string; port?: number }; webPort?: number } | null
    if (!cfg) return null
    let envBind = ''
    try {
      const envFile = readEnvFile()
      envBind = (process.env.AGIM_WEB_BIND || envFile.AGIM_WEB_BIND || '').trim()
    } catch { /* keep config/default bind */ }
    const bind = envBind || (typeof cfg.web?.bind === 'string' ? cfg.web.bind : '127.0.0.1')
    const port = typeof cfg.web?.port === 'number'
      ? cfg.web.port
      : typeof cfg.webPort === 'number'
        ? cfg.webPort
        : DEFAULT_WEB_PORT
    return { bind, port }
  } catch { return null }
}

/** Get the configured ACP bind+port. ACP is optional for first-run Web
 *  chat, but its default 9090 collides with common local proxy tools, so
 *  quickstart/doctor need to make that conflict visible. */
export function readAcpEndpoint(): TcpEndpoint {
  const cfg = readConfigObject() as { acpPort?: number } | null
  let bind = '127.0.0.1'
  try {
    const envFile = readEnvFile()
    bind = (process.env.AGIM_ACP_BIND || envFile.AGIM_ACP_BIND || bind).trim() || bind
  } catch { /* keep safe default */ }
  return {
    bind,
    port: typeof cfg?.acpPort === 'number' ? cfg.acpPort : DEFAULT_ACP_PORT,
  }
}

/** Best-effort owner for a listening TCP port. Used only for human-facing
 *  diagnostics; absence of lsof (or permission limits) simply means the
 *  owner is omitted. */
export function findTcpListenOwner(port: number): string | undefined {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const row = out.split(/\r?\n/).slice(1).find(Boolean)
    if (!row) return undefined
    const cols = row.trim().split(/\s+/)
    if (cols.length < 2) return undefined
    return `${cols[0]} pid=${cols[1]}`
  } catch { return undefined }
}

export async function checkTcpListenAvailable(endpoint: TcpEndpoint): Promise<TcpPortCheck> {
  const { bind, port } = endpoint
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { bind, port, available: false, code: 'EINVAL' }
  }

  return new Promise<TcpPortCheck>((resolve) => {
    const server = createNetServer()
    let settled = false
    const done = (result: TcpPortCheck): void => {
      if (settled) return
      settled = true
      server.removeAllListeners()
      resolve(result)
    }

    server.once('error', (err: Error & { code?: string }) => {
      done({
        bind,
        port,
        available: false,
        code: err.code,
        owner: findTcpListenOwner(port),
      })
    })
    server.once('listening', () => {
      server.close(() => done({ bind, port, available: true }))
    })
    try {
      server.listen(port, bind)
    } catch (err) {
      const e = err as Error & { code?: string }
      done({ bind, port, available: false, code: e.code ?? e.name })
    }
  })
}

/** R14 — find every Agim process running on this host.
 *  Includes pids from background spawns AND systemd-spawned children
 *  that may have escaped the cgroup (the failure mode that motivated
 *  R14: a dbus-run-session wrapper detaches its children from
 *  systemd's control group, leaving the previous agim alive after
 *  `systemctl stop` "succeeds").
 *
 *  R15 — argv-strict matching. Pre-R15 this used `pgrep -af "agim start"`
 *  which matched any process whose cmdline contained the substring
 *  "agim start" anywhere — meaning a `bash -c 'echo "agim start"'` test
 *  helper got SIGTERM'd by the reap path. Now we read /proc/<pid>/cmdline
 *  directly and require:
 *    - argv[0] basename is a node-like interpreter (node / bun)
 *    - argv[1] basename is an agim entry script (agim / cli.js)
 *    - argv[2] is the literal string 'start'
 *  This is impossible for a shell to satisfy — shells have argv[0]=bash.
 *
 *  Non-Linux (darwin / windows) falls back to ps output; /proc isn't
 *  available there, and those platforms aren't the R14 motivating case
 *  (server-side cgroup escapes need systemd + Linux). */
export function findAgimProcesses(): number[] {
  if (process.platform === 'linux') {
    try { return findAgimProcessesViaProc() } catch { /* fall through */ }
  }
  return findAgimProcessesViaPs()
}

function isAgimStartArgv(argv: string[]): boolean {
  if (argv.length < 3) return false
  // Strip a `.exe` suffix before matching: the bun npm binary is
  // `bun.exe` even on Linux, so `process.execPath` (and thus argv[0] of
  // any agim or test process launched under bun) resolves to `bun.exe`.
  // Without this, bun-launched instances were never recognised.
  const exe = basename(argv[0]).replace(/\.exe$/, '')
  const isNodeLike = exe === 'node' || exe === 'bun' || exe.startsWith('node')
  if (!isNodeLike) return false
  const script = basename(argv[1])
  const isAgimEntry = script === 'agim' || script === 'cli.js'
  if (!isAgimEntry) return false
  return argv[2] === 'start'
}

/** Linux precise path — walk /proc and validate argv shape. */
function findAgimProcessesViaProc(): number[] {
  const pids: number[] = []
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = parseInt(name, 10)
    let raw: string
    try {
      raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
    } catch {
      continue  // process exited / not readable
    }
    // /proc/<pid>/cmdline is null-byte separated; trailing null possible.
    const argv = raw.split('\x00').filter((s) => s.length > 0)
    if (isAgimStartArgv(argv)) pids.push(pid)
  }
  return pids
}

/** `ps` fallback for platforms without /proc. We still validate the argv
 *  shape instead of substring matching so shell scripts that merely contain
 *  "agim start" are not treated as Agim processes. */
function findAgimProcessesViaPs(): number[] {
  try {
    const out = execSync('ps -axo pid=,command=', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const lines = out.split('\n').filter(Boolean)
    const pids: number[] = []
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const pid = parseInt(match[1], 10)
      if (!Number.isFinite(pid) || pid <= 0) continue
      const argv = match[2].trim().split(/\s+/).filter(Boolean)
      if (isAgimStartArgv(argv)) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

/** R14 — SIGTERM then SIGKILL any agim process not in the excludeSet.
 *  Used by the web restart handler to clear stray instances that
 *  escaped systemd's cgroup before invoking `systemctl restart` (the
 *  cgroup-kill on stop will then have nothing left to fail on, and
 *  the new MainPID gets a clean port).
 *
 *  Returns the pids actually reaped (signalled + confirmed dead).
 *  Best-effort: a pid we can't signal (permissions, already exited)
 *  is silently dropped — caller is interested in "what we killed",
 *  not in surfacing failures the OS already handled. */
export async function reapStrayAgimProcesses(opts: {
  excludePids?: number[]
  sigtermTimeoutMs?: number
} = {}): Promise<{ reaped: number[]; survived: number[] }> {
  const exclude = new Set<number>([process.pid, ...(opts.excludePids ?? [])])
  const sigtermTimeoutMs = opts.sigtermTimeoutMs ?? 5_000
  const candidates = findAgimProcesses().filter((pid) => !exclude.has(pid))
  if (candidates.length === 0) return { reaped: [], survived: [] }

  // Phase 1: SIGTERM everyone. We don't wait between signals — the
  // pids represent independent processes, so a delay would
  // sequentially expose us to a worst-case (N * sigtermTimeoutMs).
  for (const pid of candidates) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone / no perms */ }
  }

  // Poll until either everyone exited or the timeout fires. 200ms
  // poll is cheap and matches the dominant "well-behaved process
  // exits in <1s" case.
  const deadline = Date.now() + sigtermTimeoutMs
  while (Date.now() < deadline) {
    const stillAlive = candidates.filter((pid) => pidAlive(pid))
    if (stillAlive.length === 0) {
      return { reaped: candidates, survived: [] }
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  // Phase 2: SIGKILL stragglers. They had sigtermTimeoutMs to clean
  // up; we now release the port and leave the OS to GC them.
  const stillAlive = candidates.filter((pid) => pidAlive(pid))
  for (const pid of stillAlive) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  // Last sweep — distinguish reaped (we did kill, now dead) from
  // survived (we tried but kernel still shows alive, e.g. zombie
  // parent).
  await new Promise((r) => setTimeout(r, 200))
  const survived = stillAlive.filter((pid) => pidAlive(pid))
  return {
    reaped: candidates.filter((pid) => !survived.includes(pid)),
    survived,
  }
}
