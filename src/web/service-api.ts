// service-api — web REST surface for system-service lifecycle + log tail.
//
// Endpoints exposed:
//
//   GET  /api/service/status      → { mode, pid, uptimeSec, uptime, web, bootPhase, … }
//   GET  /api/service/log-tail    → { path, exists, content, lines, truncated, size, mtime }
//   POST /api/service/start       → { ok, started?, alreadyRunning?, pid? }
//   POST /api/service/stop        → { ok, mode, exiting? }
//   POST /api/service/restart     → { ok, mode, restarting? }
//
// Auth: status is open to any authenticated peer; log-tail + start/stop/restart
// require admin (same gates as the original server.ts route table).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat, open } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { sendJson } from './http-utils.js'
import { requireAdmin } from './auth.js'
import { logger as rootLogger } from '../core/logger.js'

const serviceLog = rootLogger.child({ component: 'web' })

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served (caller should stop walking its own route table); `false`
 * when the URL/method didn't match anything in this module.
 */
export async function handleServiceApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/service/status' && m === 'GET') {
    await handleServiceStatus(res); return true
  }
  if (p === '/api/service/log-tail' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleServiceLogTail(res, url); return true
  }
  if (p === '/api/service/start' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleServiceStart(res); return true
  }
  if (p === '/api/service/stop' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleServiceStop(res); return true
  }
  if (p === '/api/service/restart' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleServiceRestart(res); return true
  }
  return false
}

// ─── handlers ───────────────────────────────────────────────────────

async function handleServiceStatus(res: ServerResponse): Promise<void> {
  try {
    const { detectService, formatUptime, readWebEndpoint } = await import('../cli-ui/service.js')
    const { getBootInfo } = await import('../core/boot-state.js')
    const st = detectService()
    const web = readWebEndpoint()
    const boot = getBootInfo()
    sendJson(res, 200, {
      mode: st.mode,
      pid: st.pid,
      uptimeSec: st.uptimeSec ?? null,
      uptime: typeof st.uptimeSec === 'number' ? formatUptime(st.uptimeSec) : null,
      web,
      // v1.5 — fine-grained boot phase so the web restart-polling UI can
      // wait for full readiness instead of merely "HTTP server is up".
      bootPhase: boot.phase,
      bootMsSinceStart: boot.msSinceStart,
      bootPhaseTimings: boot.phaseTimings,
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleServiceLogTail(res: ServerResponse, url: URL): Promise<void> {
  try {
    const { LOG_FILE } = await import('../cli-ui/service.js')
    const requestedLines = parseInt(url.searchParams.get('lines') || '120', 10)
    const lines = Math.min(Math.max(Number.isFinite(requestedLines) ? requestedLines : 120, 20), 500)
    const maxBytes = 256 * 1024

    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(LOG_FILE)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        sendJson(res, 200, {
          path: LOG_FILE,
          exists: false,
          content: '',
          lines: 0,
          truncated: false,
          size: 0,
          mtime: null,
        })
        return
      }
      throw err
    }

    if (!st.isFile()) {
      sendJson(res, 400, { error: 'Service log path is not a regular file' })
      return
    }

    const start = Math.max(0, st.size - maxBytes)
    const len = st.size - start
    let buf: Buffer
    const fd = await open(LOG_FILE, 'r')
    try {
      buf = Buffer.alloc(len)
      const { bytesRead } = await fd.read(buf, 0, len, start)
      buf = buf.subarray(0, bytesRead)
    } finally {
      await fd.close()
    }

    let text = buf.toString('utf8')
    if (start > 0) text = text.replace(/^[^\n]*(\n|$)/, '')
    const allLines = text.split(/\r?\n/)
    const selected = allLines.slice(-lines)
    const content = selected.join('\n')
    sendJson(res, 200, {
      path: LOG_FILE,
      exists: true,
      content,
      lines: content ? selected.length : 0,
      truncated: start > 0 || allLines.length > lines,
      size: st.size,
      mtime: st.mtime.toISOString(),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleServiceStart(res: ServerResponse): Promise<void> {
  try {
    const { detectService, spawnBackground, reapStrayAgimProcesses } = await import('../cli-ui/service.js')
    const st = detectService()

    // R14 §四 — when systemd owns the unit, ALL lifecycle commands
    // must route through systemctl so systemd stays the single
    // authority. Previously this handler bypassed systemd entirely
    // (always spawnBackground), creating a second instance
    // competing for port 3000. Now:
    //   - systemd active → no-op, report alreadyRunning
    //   - systemd inactive/failed/activating → systemctl start
    //     (preceded by reap so any stray pids from a botched
    //      previous run get cleared first; same cgroup-escape
    //      recovery as restart).
    if (st.mode === 'systemd') {
      if (st.active === 'active') {
        sendJson(res, 200, { ok: true, alreadyRunning: true, mode: 'systemd', pid: st.pid, active: st.active })
        return
      }
      try {
        const reap = await reapStrayAgimProcesses({
          excludePids: st.pid != null ? [st.pid] : [],
          sigtermTimeoutMs: 5_000,
        })
        if (reap.reaped.length > 0 || reap.survived.length > 0) {
          serviceLog.warn({
            event: 'web.service.start.reap',
            reaped: reap.reaped,
            survived: reap.survived,
          }, `R14 reap before systemctl start: killed ${reap.reaped.length} stray pid(s)`)
        }
      } catch (err) {
        serviceLog.warn({ event: 'web.service.start.reap_failed', err: String(err) })
      }
      try {
        const { spawn } = await import('node:child_process')
        const unitName = 'agim.service'
        // Detached + fire-and-forget so the HTTP response isn't held
        // for the full systemd activation timeline.
        const child = spawn('systemctl', ['start', unitName], { detached: true, stdio: 'ignore' })
        child.unref()
        sendJson(res, 200, { ok: true, mode: 'systemd', starting: true, previousActive: st.active })
      } catch (err) {
        sendJson(res, 500, { error: `systemctl start spawn failed: ${err instanceof Error ? err.message : String(err)}` })
      }
      return
    }

    // Non-systemd: existing behavior.
    if (st.mode !== 'none') {
      sendJson(res, 200, { ok: true, alreadyRunning: true, mode: st.mode, pid: st.pid })
      return
    }
    const { fileURLToPath: f } = await import('node:url')
    const __dn = dirname(f(import.meta.url))
    const cliJs = join(__dn, '..', 'cli.js')
    const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
    sendJson(res, 200, { ok: true, started: true, pid })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleServiceStop(res: ServerResponse): Promise<void> {
  const { detectService, reapStrayAgimProcesses } = await import('../cli-ui/service.js')
  const st = detectService()
  if (st.mode === 'systemd') {
    // systemctl stop handles the kill for us — no self-exit needed.
    try {
      const { execSync } = await import('node:child_process')
      const unitName = 'agim.service'
      execSync(`systemctl stop ${unitName}`)
      // R14 §四 — sweep stray pids after systemctl stop, same way
      // restart does pre-stop. systemctl reports success when its
      // cgroup-kill returns, even if a child escaped the control
      // group (the dbus-run-session bug). We finish the job here so
      // a subsequent web Start doesn't EADDRINUSE-loop. Exclude
      // process.pid via reap's built-in self-exclusion — we don't
      // want to kill the very process answering this HTTP request.
      try {
        const reap = await reapStrayAgimProcesses({ sigtermTimeoutMs: 5_000 })
        if (reap.reaped.length > 0 || reap.survived.length > 0) {
          serviceLog.warn({
            event: 'web.service.stop.reap',
            reaped: reap.reaped,
            survived: reap.survived,
          }, `R14 reap after systemctl stop: killed ${reap.reaped.length} stray pid(s)`)
        }
      } catch { /* best-effort */ }
      sendJson(res, 200, { ok: true, mode: 'systemd' })
    } catch (err) {
      sendJson(res, 500, { error: `systemctl stop failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return
  }
  // Background / foreground: respond, then SIGTERM self in next tick.
  sendJson(res, 200, { ok: true, mode: st.mode, exiting: true })
  setTimeout(() => {
    try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(0) }
  }, 200)
}

async function handleServiceRestart(res: ServerResponse): Promise<void> {
  const { detectService, reapStrayAgimProcesses } = await import('../cli-ui/service.js')
  const st = detectService()
  if (st.mode === 'systemd') {
    // R14 — reap stray agim processes BEFORE systemctl restart. The
    // motivating bug: a dbus-run-session wrapper in keyring.conf
    // detached its children from systemd's cgroup, so old agim
    // outlived `systemctl stop` and the new instance hit EADDRINUSE
    // on port 3000. We can't fix the unit file from here, but we can
    // make web restart self-healing by sweeping pids that pgrep can
    // still see. excludePids = the current MainPID (systemd will
    // handle that one) and our own pid (this very web request is
    // running inside agim).
    try {
      const result = await reapStrayAgimProcesses({
        excludePids: st.pid != null ? [st.pid] : [],
        sigtermTimeoutMs: 5_000,
      })
      if (result.reaped.length > 0 || result.survived.length > 0) {
        serviceLog.warn({
          event: 'web.service.restart.reap',
          reaped: result.reaped,
          survived: result.survived,
        }, `R14 reap: killed ${result.reaped.length} stray agim pid(s), ${result.survived.length} survived to SIGKILL`)
        try {
          const { logAuditEvent } = await import('../core/audit-log.js')
          logAuditEvent({
            eventType: 'config.put',
            actor: 'system',
            target: 'service.restart.reap',
            outcome: 'ok',
            details: { reaped: result.reaped.length, survived: result.survived.length, mainPid: st.pid },
          })
        } catch { /* best-effort */ }
      }
    } catch (err) {
      // Reap is best-effort — log + continue to systemctl. If reap
      // failed because pgrep isn't available, systemctl restart will
      // still try (and may succeed if the cgroup is OK).
      serviceLog.warn({ event: 'web.service.restart.reap_failed', err: String(err) })
    }
    try {
      const { spawn } = await import('node:child_process')
      const unitName = 'agim.service'
      // v1.5 — fire-and-forget. execSync blocked the HTTP response until
      // systemctl had finished stop+start (5-10s), making the web button
      // look frozen to the user. Detach the child so we can ACK the
      // request immediately and let systemd do its thing.
      const child = spawn('systemctl', ['restart', unitName], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      sendJson(res, 200, { ok: true, mode: 'systemd', restarting: true })
    } catch (err) {
      sendJson(res, 500, { error: `systemctl restart spawn failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    return
  }
  if (st.mode === 'foreground') {
    // Can't safely restart someone else's foreground process from the
    // web context — the owning shell still attached to its stdio
    // expects to Ctrl-C it manually.
    sendJson(res, 409, { error: 'foreground service is running in another terminal; restart it manually (Ctrl-C + re-run)' })
    return
  }
  // background or 'none': delegate to the shared restart-flow. The flow
  // runs pre-flight checks, writes restart-pending.json with source='web'
  // (so the new daemon doesn't try to push an IM completion message —
  // browser polling handles that), and spawns the detached helper.
  const { initiateRestart } = await import('../core/restart-flow.js')
  const result = await initiateRestart({ source: 'web' })
  if (!result.ok) {
    sendJson(res, 409, { error: result.message, details: result.errors })
    return
  }
  sendJson(res, 200, { ok: true, mode: st.mode, restarting: true, message: result.message })
}
