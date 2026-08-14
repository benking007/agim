// /step-reflect [on|off] — per-session Step Reflect (步思) override for Agim Agent.
//
// DeepSeek-style per-hop think-then-act. Default on (no composer chip).
// Both true and false persist so a thread can still opt out.
// AGIM_STEP_REFLECT=disabled is an ops kill switch.

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'
import {
  isStepReflectDisabled,
  isStepReflectEnabled,
  resolveStepReflectEnv,
} from '../llm/step-reflect.js'

const ON_TOKENS = new Set(['on', 'enter', 'start', 'enable', '开', '开启'])
const OFF_TOKENS = new Set(['off', 'exit', 'stop', 'disable', '关', '关闭'])

export async function handleStepReflectCommand(args: string, ctx: RouteContext): Promise<string> {
  if (isStepReflectDisabled()) {
    return '🚫 一步一想已通过 AGIM_STEP_REFLECT=disabled 全局禁用，请联系运维。'
  }

  const token = args.trim().toLowerCase()
  const existing = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  const agent = existing?.agent || ctx.defaultAgent
  const agim = agent === 'agim' || agent === 'native'

  if (!token) {
    const cur = isStepReflectEnabled(existing) ? 'on' : 'off'
    const env = resolveStepReflectEnv()
    const override = existing?.stepReflect === true
      ? '会话已开'
      : existing?.stepReflect === false
        ? '会话已关'
        : `跟随环境 AGIM_STEP_REFLECT=${env}`
    const agentNote = agim
      ? ''
      : `\n\n⚠️ 一步一想只对 Agim Agent 生效。当前 agent **${agent}** 会忽略该标志（不会出现思考反馈）。`
    return `一步一想: \`${cur}\`（${override}；当前 agent: \`${agent}\`）

切换：
  /step-reflect on   开启（每步先思考再调工具，过程中持续反馈）
  /step-reflect off  关闭

默认开。像 DeepSeek 一样：短思考 → 工具 → 短思考 → 工具。${agentNote}`
  }

  await sessionManager.getOrCreateSession(
    ctx.platform, ctx.channelId, ctx.threadId,
    existing?.agent || ctx.defaultAgent,
  )

  const capabilityNote = agim
    ? ''
    : `\n\n⚠️ 当前 agent **${agent}** 不跑步思（仅 Agim）。标志会保存，切到 agim 后生效。`

  if (ON_TOKENS.has(token)) {
    if (existing?.stepReflect === true) return `✅ 一步一想已开启（无变化）。${capabilityNote}`
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { stepReflect: true })
    return `✅ 一步一想已开启 — 每步先思考再调工具，过程中持续反馈。/step-reflect off 关闭。${capabilityNote}`
  }

  if (OFF_TOKENS.has(token)) {
    if (existing?.stepReflect === false || (existing?.stepReflect == null && resolveStepReflectEnv() !== 'on')) {
      return 'ℹ️ 一步一想本来就是关闭状态。'
    }
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { stepReflect: false })
    return '✅ 一步一想已关闭。'
  }

  return `⚠️ 无效参数: \`${token}\`

/step-reflect on | off`
}
