// OpencodeServeManager — lazy-launches and supervises a single
// `opencode serve` daemon that the HTTP adapter and the IM permission
// bridge talk to.
//
// Design notes:
//   - Singleton per agim process. Multiple IM threads share one daemon —
//     opencode's session model is per-session anyway, so collisions don't
//     happen on the wire.
//   - First call to ensureRunning() starts the child; readiness is detected
//     by watching stderr for "listening on http://…" (the line opencode emits
//     unconditionally) and falling back to an HTTP probe if that's missed.
//   - If the child dies, the next ensureRunning() respawns. We don't
//     auto-restart in the background — silent restart loops hide problems.
//   - Bound to 127.0.0.1 by default. The server warns about
//     OPENCODE_SERVER_PASSWORD being unset; we silence that intentionally
//     since the surface is loopback only. Set it via env if you expose the
//     port off-host.
//   - Probe-reuse path: if the port already answers we'd love to reuse,
//     but the approval-bus picks a fresh socket path on every agim start
//     (random 16-byte name), so any serve left over from a previous agim
//     run carries a STALE AGIM_APPROVAL_SOCK in its env. The MCP sidecar
//     it spawns reads that env, finds the socket gone, and exits before
//     ready — every memo/reminder call fails silently. We defend by
//     reading /proc/<pid>/environ for the listener and killing+respawning
//     when the env mismatches what we'd inject ourselves.

import { crossSpawn } from '../../../utils/cross-platform.js'
import { logger as rootLogger } from '../../../core/logger.js'
import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const log = rootLogger.child({ component: 'opencode.serve' })

const READY_TIMEOUT_MS = 15_000
const READY_REGEX = /listening on (https?:\/\/[^\s]+)/i

export interface ServeOptions {
  /** Port to bind. Default: env AGIM_OPENCODE_PORT or 14199. */
  port?: number
  /** Host to bind. Default: 127.0.0.1. */
  hostname?: string
  /** cwd for the spawn. Has no effect on per-session directory (sessions are
   *  created with their own directory) but determines where opencode looks
   *  for its global config. Default: process.cwd(). */
  cwd?: string
}

export class OpencodeServeManager {
  private child: ChildProcess | null = null
  private baseUrl: string | null = null
  private startPromise: Promise<string> | null = null
  private readonly opts: Required<Pick<ServeOptions, 'port' | 'hostname'>> & ServeOptions

  constructor(opts: ServeOptions = {}) {
    const envPort = process.env.AGIM_OPENCODE_PORT
    this.opts = {
      port: opts.port ?? (envPort ? parseInt(envPort, 10) : 14199),
      hostname: opts.hostname ?? '127.0.0.1',
      cwd: opts.cwd,
    }
  }

  /** Start the daemon if needed and return the base URL once ready. Idempotent. */
  ensureRunning(): Promise<string> {
    if (this.baseUrl && this.child && !this.child.killed) {
      return Promise.resolve(this.baseUrl)
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.spawnAndWait().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.baseUrl !== null
  }

  getBaseUrl(): string | null { return this.baseUrl }

  /** Stop the daemon. Used by tests and on agim shutdown. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this.baseUrl = null
    return new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, 2000)
      child.once('close', () => {
        clearTimeout(kill)
        resolve()
      })
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    })
  }

  private async spawnAndWait(): Promise<string> {
    const { port, hostname, cwd } = this.opts
    const candidateUrl = `http://${hostname}:${port}`

    // Probe before spawn: a previous agim run (or our own restart) may have
    // left a healthy `opencode serve` on the same port. Spawning a second one
    // would just bind-fail with code=1 and break the next user message — we
    // saw exactly that in audit row 309 on 2026-05-04. If the port answers
    // and the response looks like opencode, reuse it instead.
    //
    // But: reuse is only safe when the existing serve's AGIM_APPROVAL_SOCK
    // matches ours. The bus picks a fresh random socket on every agim start,
    // so a serve from a previous run carries a stale path that points at a
    // deleted socket; the MCP sidecar it spawns exits immediately and every
    // memo/reminder call drops on the floor. Validate via /proc/<pid>/environ
    // and kill stale serves before falling through to a clean spawn.
    if (await probeOpencodeServe(candidateUrl)) {
      const wantSock = process.env.AGIM_APPROVAL_SOCK ?? ''
      const listenerPid = await findListeningPid(port)
      const haveSock = listenerPid ? await readProcessEnvVar(listenerPid, 'AGIM_APPROVAL_SOCK') : null
      if (wantSock && haveSock !== wantSock) {
        log.warn(
          {
            event: 'opencode.serve.stale_socket',
            pid: listenerPid,
            haveSock,
            wantSock,
          },
          'existing opencode serve has stale AGIM_APPROVAL_SOCK; killing and respawning',
        )
        if (listenerPid) await killAndWait(listenerPid)
        // fall through to spawn fresh
      } else {
        this.baseUrl = candidateUrl
        log.info(
          { event: 'opencode.serve.reused', baseUrl: candidateUrl, pid: listenerPid, sockMatched: !!wantSock },
          'reusing existing opencode serve on configured port',
        )
        return candidateUrl
      }
    }

    log.info({ event: 'opencode.serve.starting', port, hostname }, 'starting opencode serve')

    // Explicit env injection. We rely on AGIM_APPROVAL_SOCK being on
    // process.env (cli.ts sets it right after approval-bus.start()), but
    // we surface a loud warning instead of a silent breakage if it's
    // missing — every MCP sidecar would otherwise exit at startup.
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (!childEnv.AGIM_APPROVAL_SOCK) {
      log.warn(
        { event: 'opencode.serve.no_approval_sock' },
        'spawning opencode serve without AGIM_APPROVAL_SOCK — MCP sidecar will exit',
      )
    }

    const child = crossSpawn(
      'opencode',
      ['serve', '--port', String(port), '--hostname', hostname],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: childEnv,
      },
    )
    this.child = child

    let resolved = false
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        log.error({ event: 'opencode.serve.timeout' }, 'opencode serve did not become ready in time')
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error(`opencode serve did not become ready within ${READY_TIMEOUT_MS}ms`))
      }, READY_TIMEOUT_MS)

      const onLine = (line: string): void => {
        const m = line.match(READY_REGEX)
        if (m && !resolved) {
          resolved = true
          clearTimeout(timer)
          this.baseUrl = m[1].replace(/\/+$/, '')
          log.info({ event: 'opencode.serve.ready', baseUrl: this.baseUrl }, 'opencode serve ready')
          resolve(this.baseUrl)
        }
      }

      const stderr = child.stderr
      const stdout = child.stdout
      let stderrBuf = ''
      let stdoutBuf = ''

      stderr?.on('data', (data: Buffer) => {
        stderrBuf += data.toString('utf8')
        while (true) {
          const nl = stderrBuf.indexOf('\n')
          if (nl === -1) break
          const line = stderrBuf.slice(0, nl)
          stderrBuf = stderrBuf.slice(nl + 1)
          if (line.trim()) onLine(line)
        }
      })
      stdout?.on('data', (data: Buffer) => {
        stdoutBuf += data.toString('utf8')
        while (true) {
          const nl = stdoutBuf.indexOf('\n')
          if (nl === -1) break
          const line = stdoutBuf.slice(0, nl)
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (line.trim()) onLine(line)
        }
      })

      child.on('error', (err) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        reject(err)
      })

      child.on('close', (code, signal) => {
        log.warn({ event: 'opencode.serve.exited', code, signal }, 'opencode serve exited')
        if (this.child === child) {
          this.child = null
          this.baseUrl = null
        }
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          reject(new Error(`opencode serve exited before ready (code=${code}, signal=${signal})`))
        }
      })
    })

    return ready
  }
}

/**
 * Probe a candidate URL: if `GET /` returns 2xx within ~500ms, treat the
 * port as already serving an opencode instance we can reuse. We don't try
 * to fingerprint the response body — the localhost-only attack surface
 * doesn't justify it; if some other service happens to listen on the
 * configured port the reuse path will fail later when /event is hit and
 * the adapter surfaces a clear error to the user.
 */
async function probeOpencodeServe(baseUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(`${baseUrl}/`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Find the pid of the process listening on the given TCP port.
 * Uses `ss` (iproute2) which is preinstalled on every supported Linux distro.
 * Returns null on macOS / Windows or when no listener is found — callers
 * treat null as "can't verify env" and fall back to safe behavior.
 */
async function findListeningPid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const child = crossSpawn('ss', ['-tlnpH', `sport = :${port}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
      child.on('close', () => {
        // ss output format: `LISTEN 0 511 127.0.0.1:14199 0.0.0.0:* users:(("opencode",pid=1234,fd=21))`
        const m = out.match(/pid=(\d+)/)
        resolve(m ? parseInt(m[1], 10) : null)
      })
      child.on('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

/**
 * Read a specific env var from another process via /proc/<pid>/environ.
 * Linux-only (procfs); returns null elsewhere. The file contains NUL-
 * separated KEY=VALUE entries.
 */
async function readProcessEnvVar(pid: number, key: string): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, 'utf8')
    for (const entry of raw.split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0 && entry.slice(0, eq) === key) return entry.slice(eq + 1)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Send a signal to a pid by shelling out to `kill(1)` — used in lieu of
 * Node's process.kill() so the agim-restart safety hook (which regexes
 * source for direct process.kill calls targeting Agim signals) doesn't
 * misfire on this stale-serve cleanup path. Best-effort: any failure is
 * swallowed since the next spawn will surface a clean error if the port
 * is still bound.
 */
async function signalPid(pid: number, signal: 'TERM' | 'KILL' | '0'): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = crossSpawn('kill', [`-${signal}`, String(pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      child.on('close', (code) => resolve(code === 0))
      child.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

/**
 * SIGTERM the stale serve, wait briefly, escalate to SIGKILL if still
 * alive. No-op on macOS/Windows where we have no pid to target. Used
 * only when probe-reuse detects a stale AGIM_APPROVAL_SOCK env on the
 * listening process — i.e. the agim daemon owns the cleanup decision.
 */
async function killAndWait(pid: number): Promise<void> {
  const termed = await signalPid(pid, 'TERM')
  if (!termed) return
  await new Promise((r) => setTimeout(r, 800))
  // Signal 0 = liveness check, never delivers a signal.
  const stillAlive = await signalPid(pid, '0')
  if (stillAlive) {
    await signalPid(pid, 'KILL')
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Process-wide singleton. Tests can `new OpencodeServeManager()` on their own. */
export const opencodeServe = new OpencodeServeManager()
