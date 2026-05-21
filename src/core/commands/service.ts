// `/restart`, `/stop`, `/status` — IM slash commands for service control.
//
// Same admin-allowlist gating as the natural-language path (see
// core/service-intent.ts) so users can't bypass IMHUB_ADMIN_USERS by
// preferring the slash form.
//
// `/status` is read-only and accepts non-admin callers (it surfaces only
// uptime / agent availability — no secrets). `/restart` and `/stop`
// require admin.

import type { RouteContext } from '../router.js'
import { isAdmin, denialMessage } from '../admin-allowlist.js'
import { initiateRestart, type RestartInitiator } from '../restart-flow.js'

/** /restart [-y] — graceful service restart with pre-flight + ack +
 *  completion message after the new daemon comes up. */
export async function handleRestartCommand(args: string, ctx: RouteContext): Promise<string> {
  if (!isAdmin(ctx.platform, ctx.userId)) {
    return denialMessage(ctx.platform, ctx.userId)
  }

  // Currently `args` is ignored — placeholder for future "-y" skip-confirm
  // or "--force" override flags. Reference it to keep TS happy.
  void args

  const initiator: RestartInitiator = {
    source: 'im',
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    userId: ctx.userId,
    initialText: '/restart',
  }

  const result = await initiateRestart(initiator)
  return result.message
}

/** /stop — graceful shutdown. Routes through systemctl when systemd
 *  manages the unit so systemd's lifecycle accounting stays consistent
 *  (matters when the unit has `Restart=always` — a bare SIGTERM-self
 *  would cleanly exit and systemd would just restart it, defeating
 *  the /stop). On non-systemd installs, SIGTERMs self after a 300ms
 *  flush. */
export async function handleStopCommand(args: string, ctx: RouteContext): Promise<string> {
  if (!isAdmin(ctx.platform, ctx.userId)) {
    return denialMessage(ctx.platform, ctx.userId)
  }
  void args

  // R14 §四 follow-up — systemd-aware stop. The web `/api/service/stop`
  // handler already routes through `systemctl stop`; mirror that here
  // so IM /stop behaves consistently. Without this, IM /stop under
  // a systemd unit with Restart=always becomes a no-op (the unit
  // bounces) and IM /stop under Restart=on-failure exits but doesn't
  // free systemd's tracked state.
  const { detectService, reapStrayAgimProcesses } = await import('../../cli-ui/service.js')
  const { existsSync } = await import('node:fs')
  const svc = detectService()
  if (svc.mode === 'systemd') {
    const unitName = existsSync('/etc/systemd/system/agim.service')
      ? 'agim.service'
      : (existsSync('/etc/systemd/system/im-hub.service') ? 'im-hub.service' : null)
    if (unitName) {
      // Spawn detached so this handler can return synchronously (the
      // IM reply text needs to flush before the process dies). Same
      // pattern as the web handler.
      const { spawn } = await import('node:child_process')
      try {
        spawn('systemctl', ['stop', unitName], { detached: true, stdio: 'ignore' }).unref()
      } catch (err) {
        return `🛑 systemctl stop spawn 失败：${err instanceof Error ? err.message : String(err)}`
      }
      // R14 — schedule reap shortly after systemctl stop to clean up
      // any cgroup-escaped child. We can't await in this handler
      // (returning here gives IM the reply text), so fire off a
      // detached follow-up.
      setTimeout(() => {
        void (async () => {
          try {
            const reap = await reapStrayAgimProcesses({ sigtermTimeoutMs: 5_000 })
            if (reap.reaped.length > 0 || reap.survived.length > 0) {
              const { logger } = await import('../logger.js')
              logger.warn({
                component: 'service-cmd',
                event: 'im.stop.reap',
                reaped: reap.reaped,
                survived: reap.survived,
              }, `R14 reap after IM /stop: killed ${reap.reaped.length} stray pid(s)`)
            }
          } catch { /* best-effort */ }
        })()
      }, 1_000)
      return (
        '🛑 服务即将停止（systemd 接管）。\n' +
        '   再次启动：`systemctl start agim`'
      )
    }
  }

  // Non-systemd modes — original behavior. No initiate-state-file
  // because there's no new daemon to push a "✅ 已停止" message from;
  // the caller just sees SIGTERM in their IM stream (their last
  // reply is what we send here).
  setTimeout(() => {
    try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(0) }
  }, 300)

  return (
    '🛑 服务即将停止。\n' +
    '   后台模式：用 `agim start` 重新启动。\n' +
    '   systemd 模式：用 `systemctl start agim` 重新启动。'
  )
}

/** /status — open to everyone. Surfaces uptime + default agent +
 *  registered messengers. No secrets. */
export async function handleStatusCommand(_args: string, ctx: RouteContext): Promise<string> {
  const { registry } = await import('../registry.js')
  const { isAgentAvailableCached } = await import('../onboarding.js')
  const { formatUptime, detectService } = await import('../../cli-ui/service.js')

  const lines: string[] = ['📊 Agim 服务状态']
  const svc = detectService()
  if (svc.mode === 'none') {
    // The fact that this command ran means we're alive — paradox.
    // Most likely 'none' = detection mismatch, treat as foreground.
    lines.push(`   模式: foreground (pid ${process.pid})`)
  } else {
    const upStr = typeof svc.uptimeSec === 'number' ? `, up ${formatUptime(svc.uptimeSec)}` : ''
    lines.push(`   模式: ${svc.mode} (pid ${svc.pid ?? process.pid}${upStr})`)
  }

  const agent = ctx.defaultAgent
  let agentOk = false
  try {
    agentOk = await isAgentAvailableCached(agent)
  } catch { /* ignore */ }
  lines.push(`   默认 agent: ${agent} ${agentOk ? '✅' : '⚠️ 不可用'}`)

  const messengers = registry.listMessengers()
  lines.push(`   messengers: ${messengers.length ? messengers.join(', ') : '(none — web-console-only)'}`)

  return lines.join('\n')
}
