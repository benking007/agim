// /approval command — list or clear in-session auto-approval rules.
//
// /approval                — list current auto-allow rules + readonly status
// /approval clear          — drop every auto-allow rule for this thread
// /approval readonly       — show readonly auto-allow status for this thread
// /approval readonly on    — enable readonly auto-allow for this thread (default)
// /approval readonly off   — disable readonly auto-allow for this thread
//
// Auto-allow "all" rules are scoped per (platform, channelId, threadId).
// Readonly auto-allow has a global env switch (AGIM_AUTOALLOW_READONLY) +
// per-thread opt-out — both also keyed by the same composite.

import type { RouteContext } from '../router.js'
import { approvalBus, humanizeFingerprint, threadKey } from '../approval-bus.js'

function formatRuleKey(key: string): string {
  // Keys are stored as `${toolName}::${fingerprint}`. humanizeFingerprint
  // translates `cmd:git+status` → `命令 git status`, `dir:/tmp` → `目录 /tmp`,
  // etc. Legacy/unknown fingerprints pass through unchanged.
  const sep = key.indexOf('::')
  if (sep < 0) return key
  const tool = key.slice(0, sep)
  return `• ${tool}  ${humanizeFingerprint(key.slice(sep + 2))}`
}

export async function handleApprovalCommand(
  args: string,
  ctx: RouteContext,
): Promise<string> {
  const trimmed = args.trim()
  const lower = trimmed.toLowerCase()
  const tKey = threadKey(ctx.platform, ctx.channelId, ctx.threadId)

  if (lower === 'clear' || lower === 'reset') {
    const before = approvalBus.getAutoAllowKeys(tKey)
    approvalBus.clearAutoAllowForThread(tKey)
    if (before.length === 0) return '🧹 当前没有自动放行规则，无需清空。'
    return `🧹 已清空本会话的 ${before.length} 条自动放行规则。`
  }

  // /approval readonly [on|off]
  const roMatch = lower.match(/^(?:readonly|ro)(?:\s+(on|off|enable|disable))?$/)
  if (roMatch) {
    const action = roMatch[1]
    const tools = approvalBus.getReadonlyTools().join(' / ')
    if (action === 'on' || action === 'enable') {
      const ok = approvalBus.setReadonlyAutoAllowEnabled(tKey, true)
      if (!ok) {
        return '⚠️ 全局已通过 AGIM_AUTOALLOW_READONLY=0 关闭只读自动放行；本线程开关已置 on，但需运维同时撤销环境变量后才生效。'
      }
      return `✅ 本会话已开启「只读工具自动放行」（${tools}）。`
    }
    if (action === 'off' || action === 'disable') {
      approvalBus.setReadonlyAutoAllowEnabled(tKey, false)
      return `🔒 本会话已关闭「只读工具自动放行」。后续 ${tools} 调用都会弹审批卡片。`
    }
    // bare /approval readonly → status
    const enabled = approvalBus.isReadonlyAutoAllowEnabled(tKey)
    return [
      enabled ? '✅ 只读自动放行：开启' : '🔒 只读自动放行：关闭',
      `   覆盖工具：${tools}`,
      '',
      '`/approval readonly on`  开启（默认）',
      '`/approval readonly off` 关闭，后续读类操作恢复审批',
    ].join('\n')
  }

  const keys = approvalBus.getAutoAllowKeys(tKey)
  const roEnabled = approvalBus.isReadonlyAutoAllowEnabled(tKey)
  const tools = approvalBus.getReadonlyTools().join(' / ')
  const roLine = roEnabled
    ? `🛡 只读自动放行：开启（${tools}）— /approval readonly off 关闭`
    : '🔒 只读自动放行：关闭 — /approval readonly on 开启'

  if (keys.length === 0) {
    return [
      '📋 本会话当前没有自动放行规则。',
      '',
      '在审批提示出现时回复 all（或 全部 / 总是）即可启用：',
      '规则粒度按工具语义：Bash 看前两个 token，Read/Write 看目录，WebFetch 看主机',
      '命中后 5s 内自动放行（点 ❌ 可同时撤销规则）。',
      '',
      roLine,
    ].join('\n')
  }
  return [
    `📋 本会话自动放行规则 (${keys.length})`,
    '',
    ...keys.map(formatRuleKey),
    '',
    '撤销：触发审批后回 n（仅撤销该条规则） / /approval clear（全部清空）',
    '',
    roLine,
  ].join('\n')
}
