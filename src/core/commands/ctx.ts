// /ctx [rate] — session-scoped compression rate (压缩率)
//
// Stored on session.compactRate. Persisted via sessionManager.patchSession so
// the change survives a restart between turns. Does NOT change global env;
// global default remains auto (window-scaled).

import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'
import {
  normalizeCompactRate,
  type CompactRate,
} from '../../plugins/agents/agim-agent/context-budget.js'

const LABELS: Record<CompactRate, string> = {
  auto: '自动',
  full: '满压',
  balanced: '均衡',
  frequent: '频繁',
}

function describe(rate: CompactRate): string {
  switch (rate) {
    case 'full':
      return '接近窗口上限才压缩（优先保留原始上下文）'
    case 'balanced':
      return '中等预留，折中触发'
    case 'frequent':
      return '更早、更常压缩'
    default:
      return '按当前模型窗口自动缩放（全局默认）'
  }
}

export async function handleCtxCommand(args: string, ctx: RouteContext): Promise<string> {
  const raw = args.trim()
  if (!raw) {
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    const cur = normalizeCompactRate(session?.compactRate)
    return (
      `📦 当前压缩率: \`${cur}\`（${LABELS[cur]}）— ${describe(cur)}\n\n`
      + `/ctx auto|full|balanced|frequent\n`
      + `（别名：自动 / 满压 / 均衡 / 频繁；仅影响本会话）`
    )
  }

  const rate = normalizeCompactRate(raw)
  // Reject unknown tokens that normalize silently to auto unless user asked for auto.
  const known = /^(auto|full|late|balanced|balance|frequent|自动|满压|均衡|频繁)$/i.test(raw)
  if (!known) {
    return (
      `⚠️ 无效值: \`${raw}\`\n`
      + `/ctx auto|full|balanced|frequent\n`
      + `（别名：自动 / 满压 / 均衡 / 频繁）`
    )
  }

  await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
  await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, {
    compactRate: rate,
  })
  return `✅ 压缩率: \`${rate}\`（${LABELS[rate]}）— ${describe(rate)}（仅本会话）`
}
