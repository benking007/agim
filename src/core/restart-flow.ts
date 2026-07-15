// Restart-flow orchestration. Glues together pre-flight checks, the
// in-flight state file (so the post-restart instance can ack the
// initiator), and the existing detached-helper respawn mechanism from
// web/server.ts.
//
// Single public entry: initiateRestart(ctx). Caller (slash command
// handler / web endpoint / cli) decides whether the caller is an admin
// and only invokes this on success — admin gating lives in
// admin-allowlist.ts.
//
// Sequence:
//   1. Concurrency guard (existing restart-pending.json blocks dup)
//   2. Pre-flight checks (refuse if any errors)
//   3. Write restart-pending.json with initiator metadata
//   4. ACK to caller (caller does the actual IM reply)
//   5. Schedule SIGTERM self in ~300 ms; spawn detached helper that
//      waits for parent to die then respawns new daemon
//
// The new daemon, on startup, calls processRestartPending() (in
// restart-completion.ts) which reads the file, runs self-health, pushes
// the completion message to the initiator's IM thread, and deletes the
// file.

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGIM_HOME } from './agim-paths.js'
import { runPreflightChecks } from './restart-preflight.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'restart-flow' })

const __dirname = dirname(fileURLToPath(import.meta.url))

export const RESTART_PENDING_FILE = join(AGIM_HOME, 'restart-pending.json')
export const RESTART_FAILED_LOG = join(AGIM_HOME, 'restart-failed.log')
const LOG_FILE = join(AGIM_HOME, 'agim.log')
const PID_FILE = join(AGIM_HOME, 'agim.pid')

/** Metadata about who triggered the restart, persisted across the
 *  parent → child boundary so the new daemon can ack the right thread. */
export interface RestartInitiator {
  /** Source layer that initiated. Determines who receives the completion
   *  message. */
  source: 'im' | 'web' | 'cli'
  /** IM platform name as set on MessageContext by the inbound adapter
   *  (wechat / telegram / feishu / dingtalk / discord). Note: this is
   *  the short form used in MessageContext, NOT necessarily the same
   *  string the adapter registers under in registry.ts — restart-
   *  completion's resolveMessenger() bridges that gap.
   *  Empty when source !== 'im'. */
  platform?: string
  channelId?: string
  threadId?: string
  userId?: string
  /** Message the user sent that triggered this restart (truncated to 120
   *  chars). Helps the completion message say "✅ 已重启" rather than just
   *  appearing unprompted. */
  initialText?: string
}

export interface PendingState {
  version: 1
  initiator: RestartInitiator
  started_at: number
  prev_pid: number
  prev_version: string
  /** Best guess at when the new daemon should be up. Used by stale
   *  detection — pending files older than this + 5 minutes get garbage
   *  collected on next startup. */
  expected_complete_by: number
}

export interface InitiateResult {
  ok: boolean
  /** Friendly text the caller should surface back to the user. On success
   *  this is a "重启中..." ack; on failure it's an error explanation. */
  message: string
  /** Why we refused, when ok=false. Programmatic. */
  errors?: string[]
}

/** Best-effort package version. `npm_package_version` is set by `npm start`
 *  / `npm run` but not by a bare `node dist/cli.js`; the systemd unit
 *  exposes it via Environment lines only when explicitly configured. Fall
 *  back to a readSync of the package.json sitting next to dist/.
 *
 *  Pre-1.0.14 this branch used `require('node:fs')` to fetch readFileSync
 *  lazily — which silently threw `ReferenceError: require is not defined`
 *  on every call because the compiled output is native ESM, leaving every
 *  restart ack reading "版本 unknown". Now we import readFileSync at the
 *  top of the file like every other fs use. */
const PKG_VERSION = (() => {
  if (process.env.npm_package_version) return process.env.npm_package_version
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json')
    const j = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return typeof j.version === 'string' ? j.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

export async function initiateRestart(initiator: RestartInitiator): Promise<InitiateResult> {
  // 1. Concurrency guard. Pre-flight also looks for this, but checking
  //    here first avoids running the full check sequence when we know
  //    we'll refuse.
  if (existsSync(RESTART_PENDING_FILE)) {
    return {
      ok: false,
      message: '🛑 已有进行中的重启请求（restart-pending.json 仍在）。等待当前重启完成后再试，或手动删除文件后重试。',
      errors: ['concurrent restart in progress'],
    }
  }

  // 2. Pre-flight.
  const pre = await runPreflightChecks()
  if (!pre.ok) {
    return {
      ok: false,
      message:
        '🛑 重启取消：pre-flight 检查未通过。\n' +
        pre.errors.map((e, i) => `   ${i + 1}. ${e}`).join('\n'),
      errors: pre.errors,
    }
  }

  // 3. Write state file.
  const now = Date.now()
  const state: PendingState = {
    version: 1,
    initiator,
    started_at: now,
    prev_pid: process.pid,
    prev_version: PKG_VERSION,
    expected_complete_by: now + 30_000,
  }
  try {
    writeFileSync(RESTART_PENDING_FILE, JSON.stringify(state, null, 2))
  } catch (err) {
    return {
      ok: false,
      message: `🛑 重启取消：无法写入状态文件 ${RESTART_PENDING_FILE}（${err instanceof Error ? err.message : String(err)}）`,
      errors: [String(err)],
    }
  }

  // 3.5 Mode-aware respawn. CRITICAL: when systemd manages this
  // process we MUST NOT spawn a detached helper - it would race
  // systemctl on :3000. v1.0.10 had this exact bug.
  const { detectService } = await import('../cli-ui/service.js')
  const svcState = detectService()
  if (svcState.mode === 'foreground') {
    try { unlinkSync(RESTART_PENDING_FILE) } catch { /* ignore */ }
    return {
      ok: false,
      message:
        `🚫 重启取消：检测到前台运行的 agim（pid ${svcState.pid ?? '?'}）。它由另一个 shell 持有 stdio，请回那个终端 Ctrl-C 后重启，或改用 systemd / \`agim start --bg\`。`,
      errors: ['foreground service cannot be safely restarted from a separate context'],
    }
  }
  if (svcState.mode === 'systemd') {
    const unitName = existsSync('/etc/systemd/system/agim.service') ? 'agim.service' : null
    if (unitName) {
      // v1.1.10: deliver the "🔄 重启中…" ack SYNCHRONOUSLY before issuing
      // systemctl restart. Otherwise the message sits in outbox while the
      // process dies, the new process pushes "✅ 已重启完成…" first via
      // priority='high', and the worker only flushes the ack afterwards.
      // Result: completion appears in IM BEFORE the in-flight notice — the
      // exact reversal the screenshot showed.
      const ackMessage = pre.warnings.length === 0
        ? '🔄 重启中（systemd 接管）… 预计 5-10 秒内回来。'
        : `🔄 重启中（systemd 接管）… 预计 5-10 秒内回来。\n   注意：${pre.warnings.join('；')}`
      await deliverRestartAck(initiator, ackMessage)

      // R14 §四 follow-up — reap stray agim pids before systemctl
      // restart. The web restart path already does this; mirror it
      // here so IM /restart + CLI cmdRestart get the same cgroup-
      // escape recovery. Without this an IM admin who hits /restart
      // while the keyring.conf dbus-run-session bug is in effect
      // can EADDRINUSE-loop just like the web path used to.
      try {
        const { reapStrayAgimProcesses } = await import('../cli-ui/service.js')
        const reap = await reapStrayAgimProcesses({
          excludePids: svcState.pid != null ? [svcState.pid] : [],
          sigtermTimeoutMs: 5_000,
        })
        if (reap.reaped.length > 0 || reap.survived.length > 0) {
          log.warn({
            event: 'restart-flow.reap',
            reaped: reap.reaped,
            survived: reap.survived,
            source: initiator.source,
          }, `R14 reap before systemctl restart: killed ${reap.reaped.length} stray pid(s)`)
        }
      } catch (err) {
        log.warn({
          event: 'restart-flow.reap_failed',
          err: err instanceof Error ? err.message : String(err),
        })
      }

      log.info({
        event: 'restart-flow.systemd_restart',
        unit: unitName,
        source: initiator.source,
      }, 'issuing systemctl restart - systemd will kill+respawn this process')
      try {
        spawn('systemctl', ['restart', unitName], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      } catch (err) {
        log.error({
          event: 'restart-flow.systemctl_spawn_failed',
          err: err instanceof Error ? err.message : String(err),
        })
      }
      // ack already in flight — return empty message so the command handler
      // doesn't push a duplicate via the normal reply pipeline.
      return { ok: true, message: '' }
    }
    log.warn({ event: 'restart-flow.systemd_unit_missing' },
      'detectService said systemd but no unit file found; falling through to background helper')
  }

  // 4. Schedule helper + self-exit. We delay 300 ms so the caller's HTTP /
  //    IM response has time to flush before SIGTERM lands.
  const cliJs = join(__dirname, '..', 'cli.js')
  const helperCode = buildHelperCode(process.pid, cliJs)
  try {
    const helper = spawn(process.execPath, ['-e', helperCode], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    helper.unref()
    log.info({
      event: 'restart-flow.helper_spawned',
      helper_pid: helper.pid,
      source: initiator.source,
      platform: initiator.platform,
    }, 'detached restart helper spawned; SIGTERM scheduled')
  } catch (err) {
    return {
      ok: false,
      message: `🛑 重启取消：无法启动 helper 进程（${err instanceof Error ? err.message : String(err)}）`,
      errors: [String(err)],
    }
  }

  // v1.1.10: deliver the ack synchronously so it arrives before the
  // shutdown signal lands. Otherwise the new process's "✅ 已重启完成…"
  // push (priority='high') reaches IM first and the worker only flushes
  // this ack afterwards — reversing the order seen in chat.
  const helperAck = pre.warnings.length === 0
    ? '🔄 重启中… 预计 5–10 秒内回来。'
    : `🔄 重启中… 预计 5–10 秒内回来。\n   注意：${pre.warnings.join('；')}`
  await deliverRestartAck(initiator, helperAck)

  setTimeout(() => {
    try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(0) }
  }, 300)

  return { ok: true, message: '' }
}

/**
 * Push the "🔄 重启中…" notice via sink with priority='high' so the
 * adapter actually delivers it before the process exits. Non-IM initiators
 * (web / CLI) get the message back through their own return channel and
 * don't need a push — we skip in those cases.
 */
async function deliverRestartAck(initiator: RestartInitiator, body: string): Promise<void> {
  if (initiator.source !== 'im' || !initiator.platform || !initiator.threadId) return
  try {
    const { sink } = await import('./message-sink.js')
    await sink.deliver({
      platform: initiator.platform,
      channelId: initiator.channelId ?? '',
      threadId: initiator.threadId,
      payload: body,
      kind: 'text',
      priority: 'high',
      source: 'system',
    })
  } catch (err) {
    log.warn({
      event: 'restart-flow.ack_deliver_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to deliver restart-in-progress ack; falling back to return-message path')
  }
}

/**
 * Build the detached helper script. It:
 *   1. Polls for parent PID to die (200ms × up to 150 = 30s).
 *   2. Spawns the new daemon, redirecting stdout/stderr to agim.log.
 *   3. Writes new pid to agim.pid.
 *   4. On parent-death-timeout, records the failure into restart-failed.log
 *      and exits non-zero (no respawn — manual recovery needed).
 */
function buildHelperCode(parentPid: number, cliJs: string): string {
  const escapedCli = JSON.stringify(cliJs)
  const escapedPid = JSON.stringify(PID_FILE)
  const escapedLog = JSON.stringify(LOG_FILE)
  const escapedFailLog = JSON.stringify(RESTART_FAILED_LOG)
  const escapedExe = JSON.stringify(process.execPath)
  return [
    'const{spawn}=require("child_process");',
    'const fs=require("fs");',
    `const pid=${parentPid};`,
    'let n=0;',
    'const t=setInterval(()=>{',
    '  try{process.kill(pid,0)}catch{',
    '    clearInterval(t);',
    '    try{',
    `      const fd=fs.openSync(${escapedLog},"a");`,
    // AGIM_LOG_REDIRECTED=1: child must not tee — stdio already is agim.log.
    `      const env={...process.env,AGIM_LOG_REDIRECTED:"1"};`,
    `      const c=spawn(${escapedExe},[${escapedCli},"start"],{detached:true,stdio:["ignore",fd,fd],env});`,
    '      c.unref();',
    `      fs.writeFileSync(${escapedPid},String(c.pid)+"\\n");`,
    '      fs.closeSync(fd);',
    '    }catch(err){',
    `      try{fs.appendFileSync(${escapedFailLog},new Date().toISOString()+" helper spawn failed: "+err.message+"\\n")}catch{}`,
    '      process.exit(1);',
    '    }',
    '    process.exit(0);',
    '  }',
    '  if(++n>150){',
    '    clearInterval(t);',
    `    try{fs.appendFileSync(${escapedFailLog},new Date().toISOString()+" parent pid "+pid+" still alive after 30s — abandoning\\n")}catch{}`,
    '    process.exit(2);',
    '  }',
    '},200);',
  ].join('')
}
