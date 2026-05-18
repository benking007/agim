#!/usr/bin/env node
// Production "headless" entrypoint.
//
// Differences from `dist/cli.js start`:
//   - Skips the interactive onboarding (no readline prompts).
//   - Skips the messenger startup (Telegram/WeChat/Feishu) — this script
//     is intended for deployments that only expose the Web/REST/ACP
//     surfaces. Set IMHUB_ENABLE_MESSENGERS=1 to opt in (IM_HUB_ENABLE_MESSENGERS still works as a deprecated alias).
//
// Everything else mirrors cli.ts: load config, plugins, ACP agents,
// auto-discovery, scheduler, audit retention sweep — so /api/jobs,
// /schedule, /audit etc. all work identically to the CLI flow.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))

const { registry } = await import(join(here, 'dist/core/registry.js'))
const { sessionManager } = await import(join(here, 'dist/core/session.js'))
const { workspaceRegistry } = await import(join(here, 'dist/core/workspace.js'))
const { startWebServer } = await import(join(here, 'dist/web/server.js'))
const { startACPServer } = await import(join(here, 'dist/core/acp-server.js'))
const { loadConfig } = await import(join(here, 'dist/core/onboarding.js'))
const { startScheduler, stopScheduler, closeScheduleDb } = await import(join(here, 'dist/core/schedule.js'))
const { logger } = await import(join(here, 'dist/core/logger.js'))

const log = logger.child({ component: 'start-prod' })

const config = await loadConfig()
const defaultAgent = config.defaultAgent || 'opencode'
const webPort = config.webPort || 3000
const acpPort = config.acpPort || 9090

await sessionManager.start()
await registry.loadBuiltInPlugins()

if (Array.isArray(config.workspaces) && config.workspaces.length > 0) {
  workspaceRegistry.load({ workspaces: config.workspaces })
} else {
  workspaceRegistry.load({})
}

if (Array.isArray(config.acpAgents) && config.acpAgents.length > 0) {
  await registry.loadACPAgents(config.acpAgents)
}
if (Array.isArray(config.acpDiscoveryUrls) && config.acpDiscoveryUrls.length > 0) {
  await registry.loadDiscoveredACPAgents(config.acpDiscoveryUrls)
}

// Optional: enable IM messengers when explicitly requested. cli.ts has
// the full onboarding flow for new users; here we only wire the ones
// already configured so a misconfigured machine doesn't crash boot.
if ((process.env.IMHUB_ENABLE_MESSENGERS === '1' || process.env.IM_HUB_ENABLE_MESSENGERS === '1')) {
  for (const name of config.messengers || []) {
    const messenger = registry.getMessenger(name)
    if (messenger) {
      try {
        await messenger.start()
        log.info({ messenger: name }, 'Messenger started')
      } catch (err) {
        log.error({ messenger: name, err: err instanceof Error ? err.message : String(err) },
          'Messenger failed to start, skipping')
      }
    } else {
      log.warn({ messenger: name }, 'Configured messenger not registered, skipping')
    }
  }
}

startScheduler()

const webServer = await startWebServer({ port: webPort, defaultAgent })
const acpServer = await startACPServer({ port: acpPort, defaultAgent })

log.info({ webPort, acpPort, defaultAgent, agents: registry.listAgents().length },
  'im-hub headless started')

// ── Graceful shutdown ────────────────────────────────────────────────────
// Without this block, systemctl stop / docker stop sends SIGTERM and the
// Node default handler kills the process mid-flight — outstanding HTTP
// responses get truncated, WAL files don't checkpoint, messenger
// adapters never get a chance to ack their last poll. Mirrors cli.ts's
// gracefulShutdown but trims to the services start-prod actually
// brings up.

let shuttingDown = false
const SHUTDOWN_FORCE_EXIT_MS = Number(process.env.IMHUB_SHUTDOWN_FORCE_MS) || 10_000

async function gracefulShutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'received shutdown signal; draining services')

  // Hard cap: if any of the close hooks below hangs (rare but possible —
  // a wedged messenger long-poll, a stuck SQLite checkpoint on a slow
  // disk), we don't want systemctl to escalate to SIGKILL with an open
  // outbox. Force-exit after the budget elapses.
  const forceTimer = setTimeout(() => {
    log.warn({ ms: SHUTDOWN_FORCE_EXIT_MS }, 'shutdown budget elapsed; forcing exit')
    process.exit(1)
  }, SHUTDOWN_FORCE_EXIT_MS)
  forceTimer.unref()

  // Reverse dependency order: accept-listeners first, scheduler/session
  // last (their consumers should be gone by then).
  try { webServer?.close() } catch (err) { log.warn({ err: String(err) }, 'web close failed') }
  try { acpServer?.close() } catch (err) { log.warn({ err: String(err) }, 'acp close failed') }

  // Stop messengers if we started any.
  if ((process.env.IMHUB_ENABLE_MESSENGERS === '1' || process.env.IM_HUB_ENABLE_MESSENGERS === '1')) {
    for (const name of registry.listMessengers()) {
      const messenger = registry.getMessenger(name)
      if (messenger) {
        try { await messenger.stop() }
        catch (err) { log.warn({ messenger: name, err: String(err) }, 'messenger stop failed') }
      }
    }
  }

  try { stopScheduler(); closeScheduleDb() }
  catch (err) { log.warn({ err: String(err) }, 'scheduler close failed') }

  // Best-effort SQLite cleanup for the modules cli.ts touches; harmless
  // if a given subsystem was never used in this process.
  for (const [name, importer] of [
    ['audit-log',  () => import(join(here, 'dist/core/audit-log.js'))],
    ['job-board',  () => import(join(here, 'dist/core/job-board.js'))],
    ['reminders',  () => import(join(here, 'dist/core/reminders.js'))],
    ['memos',      () => import(join(here, 'dist/core/memos.js'))],
    ['outbox',     () => import(join(here, 'dist/core/outbox.js'))],
  ]) {
    try {
      const mod = await importer()
      if (typeof mod.stopRetentionSweep === 'function') mod.stopRetentionSweep()
      if (typeof mod.stopJobRetentionSweep === 'function') mod.stopJobRetentionSweep()
      if (typeof mod.stopReminderEngine === 'function') mod.stopReminderEngine()
      if (typeof mod.stopOutboxRetentionSweep === 'function') mod.stopOutboxRetentionSweep()
      if (typeof mod.closeAuditDb === 'function') mod.closeAuditDb()
      if (typeof mod.closeJobBoardDb === 'function') mod.closeJobBoardDb()
      if (typeof mod.closeReminderDb === 'function') mod.closeReminderDb()
      if (typeof mod.closeMemosDb === 'function') mod.closeMemosDb()
      if (typeof mod.closeOutboxDb === 'function') mod.closeOutboxDb()
    } catch (err) {
      log.warn({ module: name, err: String(err) }, 'subsystem cleanup failed')
    }
  }

  try { sessionManager.stop() }
  catch (err) { log.warn({ err: String(err) }, 'session stop failed') }

  clearTimeout(forceTimer)
  log.info({ signal }, 'shutdown complete')
  process.exit(0)
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })

// Park the event loop. The server handles keep us alive until the
// shutdown hooks call process.exit().
await new Promise(() => {})
