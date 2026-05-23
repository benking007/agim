// /skill command — operator-facing reader for the agim skills loader
// (Stage 3 / P0 #3).
//
// Subcommands:
//   /skill                  same as /skill list
//   /skill help
//   /skill list             one row per skill with status flag
//   /skill show <name>      full SKILL.md body (tier-2 manual fetch)
//   /skill refresh          force re-scan (after dropping a new SKILL.md)
//   /skill check            same as list but include requires status detail

import type { RouteContext } from '../router.js'
import {
  listSkills,
  readSkillBody,
  invalidateSkillsCache,
} from '../skills/loader.js'

const HELP = [
  '🧠 **/skill** — agim skills loader（agent 跨后端共享的 SKILL.md）',
  '',
  '用法：',
  '  `/skill`                列出所有已加载 skill (= /skill list)',
  '  `/skill list`           同上',
  '  `/skill show <name>`    打印某个 skill 的完整 SKILL.md',
  '  `/skill refresh`        强制重新扫描磁盘',
  '  `/skill check`          列出详细的 requires 状态（缺什么）',
  '',
  '在哪里放 SKILL.md：',
  '  ~/.agim/skills/<name>/SKILL.md   （operator 自定义，优先）',
  '  <agim-dist>/skills/builtin/...   （agim 内置，被同名 workspace 覆盖）',
  '',
  '三层加载：',
  '  · tier 1: 名字 + 描述，每轮注入 prompt（自动）',
  '  · tier 2: 全文 body，agent 用 mcp__imhub__read_skill(name) 取',
  '  · tier 3: scripts/ references/ assets/ 子目录，agent 走文件读取工具',
].join('\n')

export async function handleSkillCommand(args: string, ctx: RouteContext): Promise<string> {
  void ctx  // unused; skills are global
  const trimmed = args.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = (parts[0] || '').toLowerCase()
  const rest = trimmed.slice(parts[0]?.length ?? 0).trim()

  if (!sub || sub === 'list' || sub === 'ls') {
    return renderList(false)
  }

  switch (sub) {
    case 'help':
    case '?':
      return HELP

    case 'check':
    case 'status':
      return renderList(true)

    case 'show':
    case 'cat':
    case 'view': {
      const name = rest.trim()
      if (!name) return '用法：`/skill show <name>`（用 `/skill list` 查名字）'
      const body = readSkillBody(name)
      if (body === null) return `❌ 未找到 skill: ${name}`
      // IM 大段 markdown 由 viewer 自动路由；这里直接返回就行。
      return body
    }

    case 'refresh':
    case 'reload':
    case 'rescan': {
      invalidateSkillsCache()
      const after = listSkills()
      return `✅ 已重新扫描。当前 ${after.length} 个 skill。`
    }

    default:
      return `未知子命令：\`/skill ${sub}\`。用 \`/skill help\` 查看用法。`
  }
}

function renderList(detail: boolean): string {
  const skills = listSkills()
  if (skills.length === 0) {
    return '（当前没有 skill。把 SKILL.md 放到 `~/.agim/skills/<name>/SKILL.md` 后用 `/skill refresh` 重新扫描。）'
  }
  const lines: string[] = ['🧠 **agim skills**']
  for (const s of skills.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const flag = s.available ? (s.always ? '⭐' : '✅') : '⏸'
    const src = s.source === 'workspace' ? 'ws' : 'builtin'
    const reason = !s.available && s.unavailableReason ? ` — ${s.unavailableReason}` : ''
    lines.push(`${flag} \`${s.name}\` [${src}] — ${s.description}${reason}`)
    if (detail) {
      if (s.requiresBins.length > 0) lines.push(`     requires bins: ${s.requiresBins.join(', ')}`)
      if (s.requiresEnv.length > 0) lines.push(`     requires env:  ${s.requiresEnv.join(', ')}`)
      lines.push(`     dir: ${s.dir}`)
    }
  }
  return lines.join('\n')
}
