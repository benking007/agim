// `/setup` — first-run admin onboarding.
//
// Subcommand: `/setup admin <token>`
//   Consumes the one-time bootstrap token written by cli.ts at startup
//   when no admins are configured. On success, the caller (platform +
//   userId) is added to the in-memory admin list AND persisted to
//   ~/.agim/env so a restart preserves it.
//
// Future subcommands (out of scope for v1):
//   /setup status      — show whether bootstrap is consumed
//   /setup rotate-token — regenerate even when admins exist (recovery)

import type { RouteContext } from '../router.js'
import { consumeBootstrapToken } from '../admin-bootstrap.js'

export async function handleSetupCommand(args: string, ctx: RouteContext): Promise<string> {
  const trimmed = args.trim()
  if (!trimmed) {
    return [
      '⚙️  /setup 子命令：',
      '',
      '  /setup admin <token>   把当前账号设为管理员（消耗一次性 token）',
      '',
      'token 来源：',
      '  - 服务首次启动时打印到日志（journalctl / im-hub.log）',
      '  - 文件 ~/.agim/admin-bootstrap-token (chmod 600)',
      '  - 仅在还没配置管理员时存在；首次成功消费后失效',
    ].join('\n')
  }

  const parts = trimmed.split(/\s+/)
  const sub = parts[0]?.toLowerCase()

  if (sub === 'admin') {
    const token = parts.slice(1).join(' ').trim()
    if (!token) {
      return '❌ 用法：/setup admin <token>\n   token 见服务启动日志或 ~/.agim/admin-bootstrap-token'
    }
    if (!ctx.userId) {
      return '❌ 当前消息缺少 userId，无法识别身份。请通过有 userId 的 IM 渠道发起（部分匿名渠道不支持）。'
    }

    const result = await consumeBootstrapToken(token, ctx.platform, ctx.userId)
    if (!result.ok) {
      switch (result.reason) {
        case 'no_token_file':
          return (
            '❌ 没有可用的 token 文件。\n' +
            '   可能原因：\n' +
            '   · 已经有管理员配置过了（重复 /setup 会被拒）\n' +
            '   · 服务重启过且当时已有管理员，token 不再生成\n' +
            '   · 你拼写错了 token（hyphen 是必须的，比如 ABCD-EFGH-JKLM）\n' +
            '   如确需重新生成 token，请清空 IMHUB_ADMIN_USERS 后重启服务。'
          )
        case 'mismatch':
          return '❌ token 不匹配。请核对启动日志或 `cat ~/.agim/admin-bootstrap-token` 重新输入。'
        case 'missing_user_id':
          return '❌ 当前消息缺少 userId，无法识别身份。'
      }
    }

    const meAs = `${ctx.platform.toLowerCase()}:${ctx.userId}`
    if (result.alreadyAdmin) {
      return `✅ 你 (${meAs}) 已经是管理员了。token 已作废。`
    }
    return (
      `✅ 已把你 (${meAs}) 设为管理员。\n` +
      '   · token 已作废（已 unlink ~/.agim/admin-bootstrap-token）\n' +
      '   · 改动已写入 ~/.agim/env，重启服务后仍保留\n' +
      '   · 现在可以发 /restart / /stop / "重启服务" 等命令了'
    )
  }

  return `❌ 未知子命令: ${sub}。可用：/setup admin <token>`
}
