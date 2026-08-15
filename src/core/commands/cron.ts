// /cron command — manage cron-driven scheduled prompts (P2-F).
//
// /cron list                                   list all schedules
// /cron create <name> <agent> <cron> <prompt>  create
// /cron delete <id>                            delete
// /cron enable <id>                            enable
// /cron disable <id>                           disable
// /cron check <id>                             show details
//
// Cron expression is the standard 5-field POSIX format ("min hour dom mon dow").
//
// Scheduled Loop wake-ups: a prompt starting with `loop:` starts a Loop on
// a dedicated `cron:<id>` thread (does not steal the user's Focus) instead
// of a plain one-shot job. Both hard fields are required — the scheduler
// does not auto-confirm ALIGNING. Example:
//   /cron create nightly-loop agim "0 2 * * *" loop: 修复昨日故障；退出条件为验收通过或最多5轮
// Headless (auto-end on met=true) requires 无人值守 / headless in the
// mission text. AGIM_LOOP_HEADLESS=1 only applies to these scheduled runs.
//
// Renamed from /schedule in v0.2.38 to avoid colliding with Claude Code's
// built-in /schedule skill (Anthropic remote routines). The /schedule alias
// is still wired in router.ts but emits a one-line deprecation banner; it
// will be removed in v0.4.0.

import type { RouteContext } from '../router.js'
import {
  createSchedule, listSchedules, getSchedule, deleteSchedule, setEnabled,
} from '../schedule.js'
import { parseCron, nextOccurrence } from '../cron.js'
import { registry } from '../registry.js'
import { workspaceRegistry } from '../workspace.js'

export async function handleCronCommand(
  args: string,
  ctx: RouteContext
): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'

  // Same per-user scoping rule as /job. ctx.userId set → see only own rows;
  // ctx.userId unset → unrestricted (back-compat for non-IM callers).
  const ownerOpts = ctx.userId ? { creatorId: ctx.userId } : {}

  switch (sub) {
    case 'list':
    case 'ls': {
      const all = listSchedules(50, ownerOpts)
      if (!all.length) return '🗓️ 暂无定时任务。\n\n用法: /cron create <name> <agent> "<cron>" <prompt>'
      const lines = all.map((s) => {
        const flag = s.enabled ? '✅' : '⏸️'
        return `${flag} #${s.id} **${s.name}** (${s.agent})\n   cron: \`${s.cron}\`\n   下次: ${s.next_run}`
      })
      return `🗓️ **定时任务** (${all.length})\n\n${lines.join('\n\n')}\n\n/cron check <id>  详情\n/cron enable/disable <id>  启停\n/cron delete <id>  删除`
    }

    case 'create':
    case 'c': {
      // /cron create <name> <agent> "<cron>" <prompt...>
      if (parts.length < 5) {
        return '用法: /cron create <name> <agent> "<cron expr>" <prompt>\n\n例如: /cron create daily-report opencode "0 9 * * 1-5" 生成今天的销售日报'
      }
      const name = parts[1]
      const agentName = parts[2]
      // The cron expression may be quoted — try to extract.
      const restJoined = parts.slice(3).join(' ')
      let cron: string
      let prompt: string
      const quoted = restJoined.match(/^"([^"]+)"\s+(.+)$/) || restJoined.match(/^'([^']+)'\s+(.+)$/)
      if (quoted) {
        cron = quoted[1]
        prompt = quoted[2]
      } else {
        // Best effort: assume the next 5 tokens are the cron expression
        const tokens = parts.slice(3)
        if (tokens.length < 6) return '用法: /cron create <name> <agent> "<cron expr>" <prompt>'
        cron = tokens.slice(0, 5).join(' ')
        prompt = tokens.slice(5).join(' ')
      }

      // M6: workspace whitelist + agent existence check before we touch SQL.
      const agent = registry.findAgent(agentName)
      if (!agent) return `❌ Agent "${agentName}" not found.`
      const ws = workspaceRegistry.resolve(ctx.userId || 'unknown')
      if (!ws.hasAgent(agent.name)) {
        return `❌ Agent "${agent.name}" 不在 workspace "${ws.name}" 的白名单内。`
      }

      try {
        // Validate before insert so we get a clean error.
        parseCron(cron)
        const id = createSchedule({
          name, agent: agent.name, cron, prompt,
          creatorId: ctx.userId || '',
          workspaceId: ws.id,
        })
        const next = nextOccurrence(parseCron(cron))
        return `✅ 定时任务 #${id} 已创建\n\nName: ${name}\nAgent: ${agent.name}\nCron: \`${cron}\`\n下次执行: ${next?.toISOString() || 'unknown'}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `❌ 创建失败: ${msg}`
      }
    }

    case 'delete':
    case 'rm': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /cron delete <id>'
      return deleteSchedule(id, ownerOpts)
        ? `✅ 定时任务 #${id} 已删除。`
        : `❌ 未找到 #${id}，或不是你创建的。`
    }

    case 'enable':
    case 'on': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /cron enable <id>'
      return setEnabled(id, true, ownerOpts)
        ? `✅ 定时任务 #${id} 已启用。`
        : `❌ 未找到 #${id}，或不是你创建的。`
    }

    case 'disable':
    case 'off': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /cron disable <id>'
      return setEnabled(id, false, ownerOpts)
        ? `⏸️ 定时任务 #${id} 已暂停。`
        : `❌ 未找到 #${id}，或不是你创建的。`
    }

    case 'check':
    case 'show': {
      const id = parseInt(parts[1] || '', 10)
      if (!Number.isFinite(id)) return '用法: /cron check <id>'
      const s = getSchedule(id, ownerOpts)
      if (!s) return `❌ 未找到 #${id}。`
      return `🗓️ **定时任务 #${s.id}** (${s.name})\n\nAgent: ${s.agent}\n状态: ${s.enabled ? '✅ 启用' : '⏸️ 已暂停'}\nCron: \`${s.cron}\`\n下次执行: ${s.next_run}\n上次执行: ${s.last_run || '从未'}\n通知 URL: ${s.notify_url || '无'}\n\nPrompt: ${s.prompt}`
    }

    default:
      return '用法: /cron [list|create|delete|enable|disable|check]'
  }
}
