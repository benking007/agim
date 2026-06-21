// `/setup` — legacy compatibility shim.
//
// v2 auth model removes IM admin bootstrap tokens. IM admins are now chosen
// in Web Settings by a Web-admin token holder.

import type { RouteContext } from '../router.js'

export async function handleSetupCommand(args: string, ctx: RouteContext): Promise<string> {
  void args
  return [
    'ℹ️ `/setup` 已废弃。',
    '',
    '现在不再使用 IM admin token。',
    '请让 Web 后台管理员在「设置 → 管理员」中把你的 IM 账号加入管理员名单。',
    `当前账号：${ctx.platform.toLowerCase()}:${ctx.userId ?? '<unknown>'}`,
  ].join('\n')
}
