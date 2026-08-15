// /cronloop (alias /cornloop) — open the scheduled-Loop confirmation dock.
//
// Unlike `/cron create … loop: …`, this never writes a schedule immediately.
// It stashes a draft; Web shows the bottom sheet (time + mission + exit).

import type { RouteContext } from '../router.js'
import { openScheduledLoopDraft } from '../loop-schedule-intent.js'

const HELP = [
  '🔁 **/cronloop** — 打开定时 Loop 确认底栏（不静默创建）',
  '',
  '用法：',
  '  `/cronloop`',
  '  `/cronloop 每天凌晨2点 修登录；退出条件为验收通过或最多5轮`',
  '',
  '自然语言也可以：`开个定时 loop` / `每天凌晨2点用 Loop 修登录；退出条件为…`',
  '别名：`/cornloop`',
].join('\n')

export async function handleCronloopCommand(
  args: string,
  ctx: RouteContext,
): Promise<string> {
  const rest = (args || '').trim()
  if (rest === 'help' || rest === '?' || rest === '-h') return HELP
  const surface = ctx.platform === 'web' ? 'dock' : 'card'
  const opened = openScheduledLoopDraft({
    platform: ctx.platform,
    channelId: ctx.channelId,
    threadId: ctx.threadId,
    text: rest,
    surface,
  })
  return opened.reply || HELP
}
