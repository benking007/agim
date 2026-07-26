import type { StartRuntimeContext } from './start-context.js'
import { approvalBus } from '../core/approval-bus.js'
import { registry } from '../core/registry.js'
import { sink } from '../core/message-sink.js'
import { sessionManager } from '../core/session.js'

// R14 — hard deadline. If anything in the teardown chain hangs (DB
// checkpoint, stuck child wait, sidecar TCP keepalive), we still
// force-exit within 25s so a follow-up `systemctl restart` finds
// the port released. systemd's TimeoutStopSec is 30s; we leave a
// 5s buffer so the process exits on our terms (exit code 1)
// before systemd escalates to SIGKILL.
const HARD_SHUTDOWN_MS = 25_000

export async function gracefulShutdown(ctx: StartRuntimeContext, signal: string, exitCode = 0): Promise<void> {
  ctx.shutdownExitCode = Math.max(ctx.shutdownExitCode, exitCode)
  if (ctx.shuttingDown) return
  ctx.shuttingDown = true
  console.log(`\n👋 Received ${signal}, shutting down...`)

  const hardKill = setTimeout(() => {
    console.error(`⏱  Graceful shutdown exceeded ${HARD_SHUTDOWN_MS}ms — forcing exit(1).`)
    // Last-ditch: try to release the port before the kernel does
    // it on exit. close() is safe to call from a fired timer
    // because shuttingDown is true so nothing re-enters this fn.
    try { ctx.webServer?.close() } catch { /* ignore */ }
    // PID_FILE cleanup intentionally NOT done here — the next
    // start's self-check uses pidAlive(recorded), which returns
    // false for our soon-to-be-dead pid, so stale file is harmless.
    process.exit(1)
  }, HARD_SHUTDOWN_MS)
  // Don't keep the event loop alive solely for this timer; if
  // shutdown completes naturally, clearTimeout below + the natural
  // process.exit(0) wins.
  if (typeof hardKill.unref === 'function') hardKill.unref()

  // PORT RELEASE FIRST — close webServer at the top of
  // the chain (was previously after sessionManager.stop, which is
  // cheap but unnecessary friction). closeAllConnections() (added
  // inside startWebServer in R14) force-drops
  // in-flight sockets so the listener actually releases the port
  // before any DB / messenger teardown begins.
  sessionManager.stop()
  try {
    const { stopAgimAgentSessionRetention } = await import('../core/agim-agent-session-lifecycle.js')
    stopAgimAgentSessionRetention()
  } catch { /* ignore */ }
  try { ctx.webServer?.close() } catch { /* ignore */ }

  // Stop the cloudflared subprocess (if we forked one for viewer auto-tunnel).
  // Doing this early gives it a clean SIGTERM exit before we tear down the
  // rest; otherwise it would exit on parent-process close with no cleanup.
  try {
    const { stopTunnel } = await import('../core/tunnel.js')
    stopTunnel()
  } catch { /* ignore */ }

  // v1.5 — stop the memory consolidator timer.
  try {
    const { stopMemoryConsolidator } = await import('../core/memory-consolidate.js')
    stopMemoryConsolidator()
  } catch { /* ignore */ }

  // Stop the outbox worker BEFORE messengers so no new send attempts
  // race the adapter shutdown. Worker is single-threaded so a pending
  // tick will finish its current row before we move on.
  try { sink.stopWorker() } catch { /* ignore */ }

  // Phase 3: any inline job that was still pending/running gets stamped
  // 'interrupted' so the next startup's recovery scan can offer the user
  // a retry. Must happen BEFORE closeJobBoardDb() below, while the
  // handle is still open.
  try {
    const { markRunningInlineJobsInterrupted } = await import('../core/job-board.js')
    markRunningInlineJobsInterrupted(`agim shutdown (${signal})`)
  } catch { /* ignore */ }

  // Stop all messengers
  for (const name of registry.listMessengers()) {
    const messenger = registry.getMessenger(name)
    if (messenger) {
      await messenger.stop()
    }
  }

  // Stop approval bus last — denies any in-flight approvals so sidecar
  // processes don't hang. Always called even if start() failed earlier.
  try { await approvalBus.stop() } catch { /* ignore */ }

  // L2: stop background sweepers and checkpoint SQLite WAL files before
  // exiting. Without these, the next startup has to recover the WAL
  // (cheap but visible in logs and slows boot).
  try {
    const { stopRetentionSweep, closeAuditDb } = await import('../core/audit-log.js')
    stopRetentionSweep()
    closeAuditDb()
  } catch { /* ignore */ }
  try {
    const { stopJobRetentionSweep, closeJobBoardDb } = await import('../core/job-board.js')
    stopJobRetentionSweep()
    closeJobBoardDb()
  } catch { /* ignore */ }
  try {
    const { stopScheduler, closeScheduleDb } = await import('../core/schedule.js')
    stopScheduler()
    closeScheduleDb()
  } catch { /* ignore */ }
  try {
    const { stopReminderEngine, closeReminderDb } = await import('../core/reminders.js')
    stopReminderEngine()
    closeReminderDb()
  } catch { /* ignore */ }
  try {
    const { closeMemosDb } = await import('../core/memos.js')
    closeMemosDb()  // also stops the sweep timer
  } catch { /* ignore */ }
  try {
    const { stopOutboxRetentionSweep, closeOutboxDb } = await import('../core/outbox.js')
    stopOutboxRetentionSweep()
    closeOutboxDb()
  } catch { /* ignore */ }

  // R14 — kill the opencode-serve daemon (singleton subprocess).
  // Before R14 this was never stopped explicitly; it relied on
  // parent-exit propagation, which leaves the child as a zombie
  // when agim is killed by SIGKILL or when the cgroup is broken
  // (the exact failure mode that motivated R14). Inline import
  // keeps the lazy graph clean for non-opencode deployments.
  try {
    const { opencodeServe } = await import('../plugins/agents/opencode/serve-manager.js')
    await opencodeServe.stop()
  } catch { /* ignore — opencode wasn't configured / never spawned */ }

  // R15 — pair the start-path PID_FILE write. We only unlink when
  // the file's pid matches OUR pid; defensive against a race where
  // a fresh agim has already overwritten it (we don't want to
  // delete the new owner's file just because our shutdown started
  // first).
  try {
    const { PID_FILE: _pidFile } = await import('../cli-ui/service.js')
    const { existsSync: _exists, readFileSync: _read, unlinkSync: _unlink } = await import('node:fs')
    if (_exists(_pidFile)) {
      const recorded = parseInt(_read(_pidFile, 'utf-8').trim(), 10)
      if (recorded === process.pid) _unlink(_pidFile)
    }
  } catch { /* missing / unreadable is fine */ }

  clearTimeout(hardKill)
  process.exit(ctx.shutdownExitCode)
}
