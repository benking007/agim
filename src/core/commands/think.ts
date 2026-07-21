// /think [level] — thinking/reasoning depth
//
// Stored on session.variant. Persisted via sessionManager.patchSession so
// the change survives a restart between turns.

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

const VALID_LEVELS = new Set(['high', 'low', 'max', 'minimal'])

export async function handleThinkCommand(args: string, ctx: RouteContext): Promise<string> {
  const level = args.trim().toLowerCase()

  if (!level) {
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    const cur = session?.variant || 'auto'
    return `💭 当前思考深度: \`${cur}\`\n\n/think high | max | low | minimal | off | auto\n（DeepSeek / Kimi / GLM：auto/空默认 high；max → reasoning_effort=max）`
  }

  // Ensure a session exists so the patch is always durable.
  await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)

  if (level === 'off' || level === 'none') {
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { variant: 'off' })
    return '✅ 已关闭深度思考。'
  }
  if (level === 'auto') {
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { variant: '' })
    return '✅ 思考深度: auto（DeepSeek / Kimi / GLM 默认 high）。'
  }
  if (level === 'xhigh') {
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { variant: 'max' })
    return '✅ 思考深度: `max`'
  }
  if (VALID_LEVELS.has(level)) {
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { variant: level })
    return `✅ 思考深度: \`${level}\``
  }

  return `⚠️ 无效值: \`${level}\`\n/think high | max | low | minimal | off | auto`
}
