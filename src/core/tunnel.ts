// Tunnel — auto-launch cloudflared quick tunnel so operators without a
// public DNS / reverse proxy can still receive viewer links in IM.
//
// Trade-off: quick tunnels are ephemeral. The URL is a random
// `https://*.trycloudflare.com` reassigned per `cloudflared` process.
// On agim restart, IM links generated before the restart become dead.
// Operators who want stable URLs should configure
// `IMHUB_VIEWER_PUBLIC_BASE_URL` to a reverse proxy (caddy / tailscale /
// cloudflared named tunnel) instead — when that env is non-empty we
// skip the auto-tunnel.
//
// We deliberately do NOT bundle cloudflared in the npm package (binary is
// ~30 MB and architecture-specific). Operators install it themselves
// (`brew install cloudflared` / `apt install cloudflared` / download from
// https://github.com/cloudflare/cloudflared/releases). agim auto-detects
// the binary on `start` and emits a friendly install hint if missing.

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'tunnel' })

const URL_RE = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i

let proc: ChildProcess | null = null
let currentUrl: string | null = null
let lastError: string | null = null
let lastStartAt: number | null = null
let restartTimer: NodeJS.Timeout | null = null

export interface TunnelStatus {
  running: boolean
  url: string | null
  binaryFound: boolean
  binaryPath: string | null
  lastError: string | null
  startedAt: number | null
}

/** Common locations where cloudflared may be installed. PATH is searched first. */
const CANDIDATE_PATHS = [
  '/usr/local/bin/cloudflared',
  '/usr/bin/cloudflared',
  '/opt/homebrew/bin/cloudflared',
  '/root/.agim/bin/cloudflared',
  `${process.env.HOME || ''}/.agim/bin/cloudflared`,
]

export function findCloudflared(): string | null {
  // PATH first (so users who installed via package manager / homebrew "just work").
  const which = process.platform === 'win32' ? 'where' : 'which'
  try {
    const result = execSync(`${which} cloudflared`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    if (result && existsSync(result.split('\n')[0])) {
      return result.split('\n')[0]
    }
  } catch {
    // fall through
  }
  for (const p of CANDIDATE_PATHS) {
    if (p && existsSync(p)) return p
  }
  return null
}

export function getTunnelStatus(): TunnelStatus {
  const bin = findCloudflared()
  return {
    running: proc !== null && !proc.killed,
    url: currentUrl,
    binaryFound: bin !== null,
    binaryPath: bin,
    lastError,
    startedAt: lastStartAt,
  }
}

/**
 * Start a cloudflared quick tunnel pointing at the given local port. Idempotent
 * — if a tunnel is already running, returns immediately. The function resolves
 * as soon as the child is spawned; the URL is captured asynchronously from
 * stderr and made available via getTunnelStatus().
 *
 * Throws if cloudflared isn't installed (so the caller can surface the install
 * hint to the operator).
 */
export function startTunnel(localPort: number): void {
  if (proc && !proc.killed) {
    log.debug({ event: 'tunnel.already_running', url: currentUrl }, 'tunnel already running')
    return
  }
  const bin = findCloudflared()
  if (!bin) {
    lastError = 'cloudflared binary not found in PATH; install from https://github.com/cloudflare/cloudflared/releases or via your OS package manager'
    log.warn({ event: 'tunnel.binary_missing', candidates: CANDIDATE_PATHS },
      lastError)
    return
  }

  const localUrl = `http://127.0.0.1:${localPort}`
  log.info({ event: 'tunnel.start', binary: bin, localUrl }, `starting cloudflared quick tunnel → ${localUrl}`)

  proc = spawn(bin, [
    'tunnel',
    '--url', localUrl,
    '--no-autoupdate',
    // Quick tunnels: no login, no zone — gives us a random trycloudflare.com URL.
    // Logging goes to stderr by default; we tap it to extract the URL.
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  lastStartAt = Date.now()
  lastError = null
  currentUrl = null

  const captureFromChunk = (chunk: Buffer | string): void => {
    const text = chunk.toString('utf8')
    const m = URL_RE.exec(text)
    if (m && !currentUrl) {
      currentUrl = m[0].replace(/\/$/, '')
      log.info({ event: 'tunnel.url_acquired', url: currentUrl }, `tunnel URL: ${currentUrl}`)
    }
    // cloudflared echoes its own status to stderr; surface ERR lines to our log.
    if (/error|failed|refused/i.test(text)) {
      log.warn({ event: 'tunnel.stderr', text: text.trim().slice(0, 400) })
    }
  }
  proc.stderr?.on('data', captureFromChunk)
  proc.stdout?.on('data', captureFromChunk)

  proc.on('exit', (code, signal) => {
    log.warn({ event: 'tunnel.exit', code, signal, url: currentUrl },
      `cloudflared exited (code=${code}, signal=${signal})`)
    const wasUrl = currentUrl
    proc = null
    currentUrl = null
    lastError = `cloudflared exited (code=${code}${signal ? `, signal=${signal}` : ''})`
    // Auto-restart on non-clean exit so a brief network blip doesn't kill the
    // tunnel for the rest of the agim process lifetime. 30s cooldown.
    if (signal !== 'SIGTERM' && signal !== 'SIGINT') {
      restartTimer = setTimeout(() => {
        log.info({ event: 'tunnel.auto_restart', previousUrl: wasUrl }, 'auto-restarting tunnel')
        startTunnel(localPort)
      }, 30_000)
    }
  })

  proc.on('error', (err) => {
    lastError = `spawn failed: ${err.message}`
    log.error({ event: 'tunnel.spawn_error', err: err.message })
  })
}

export function stopTunnel(): void {
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (proc && !proc.killed) {
    log.info({ event: 'tunnel.stop' })
    proc.kill('SIGTERM')
    proc = null
    currentUrl = null
  }
}

export function getCurrentTunnelUrl(): string | null {
  return currentUrl
}
