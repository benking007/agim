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

/** /stop — graceful shutdown. Sends SIGTERM to self after acking the
 *  caller; no helper respawn (unlike /restart). Useful only via systemd
 *  (which won't restart on clean exit when WantedBy=multi-user.target is
 *  removed) or for "I'm done, going to sleep" workflows. For background
 *  mode, the user must `agim start` again manually. */
export async function handleStopCommand(args: string, ctx: RouteContext): Promise<string> {
  if (!isAdmin(ctx.platform, ctx.userId)) {
    return denialMessage(ctx.platform, ctx.userId)
  }
  void args

  // No initiate-state-file because there's no new daemon to push a "✅
  // 已停止" message from. The caller just sees SIGTERM in their IM stream
  // (their last reply is what we send here).
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
