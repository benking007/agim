// `/setup` — IM compatibility shim.
//
// First-run onboarding now lives in the browser at /setup. IM admins
// are assigned in Web Settings → Admins. Keep this command so `/setup`
// never becomes "unknown command".

import type { RouteContext } from '../router.js'

export async function handleSetupCommand(args: string, ctx: RouteContext): Promise<string> {
  void args
  return [
    'ℹ️ `/setup` 已改为浏览器向导。',
    '',
    '请在本机打开 Web 控制台的 /setup 页完成模型与 API Key（默认 http://localhost:3000/setup）。',
    'IM 管理员请让 Web 后台在「设置 → 管理员」中把你的账号加入名单。',
    `当前账号：${ctx.platform.toLowerCase()}:${ctx.userId ?? '<unknown>'}`,
  ].join('\n')
}
