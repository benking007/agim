/**
 * Agent specialty profiles — used by Agim (Loop parent / call_agents) to
 * pick the right CLI Subagent. Agim Agent itself is the orchestrator and
 * is intentionally omitted.
 *
 * SSOT for builtin defaults lives here. Operators override via
 * `config.agentProfiles` (Settings → Agents). Effective = defaults ⊕ overrides.
 */

import { isAgimAgentId, normalizeAgentId } from './naming-migrate.js'
import { getLiveConfig } from './live-config.js'

export interface AgentProfile {
  /** One-line specialty (shown in Settings + injected into prompts). */
  summary: string
  /** What this agent is good at. */
  strengths: string[]
  /** What to avoid assigning. */
  avoid: string[]
  /** Short English tags for matching / UI chips. */
  tags: string[]
}

/** Canonical non-Agim built-in adapter ids (registry names). */
export const NON_AGIM_AGENT_IDS = [
  'claude-code',
  'codex',
  'copilot',
  'opencode',
  'antigravity',
  'cursor',
  'kimi-code',
  'qoder',
  'pi',
  'mimo',
] as const

export type NonAgimAgentId = (typeof NON_AGIM_AGENT_IDS)[number]

export function isNonAgimAgentId(id: string | undefined | null): id is NonAgimAgentId {
  const n = normalizeAgentId(id || '')
  return (NON_AGIM_AGENT_IDS as readonly string[]).includes(n)
}

/** Builtin defaults — keep summaries actionable for call_agents routing. */
export const DEFAULT_AGENT_PROFILES: Record<NonAgimAgentId, AgentProfile> = {
  'claude-code': {
    summary: '复杂推理与工程改造：架构分析、多步实现、代码审查、解释与文档。',
    strengths: [
      '跨文件/模块的架构设计与重构',
      '代码审查与安全/质量问题排查',
      '多步工具调用的复杂实现',
      '解释现有系统、写设计/变更说明',
      '需要强推理的模糊需求澄清',
    ],
    avoid: [
      '只需改一两行的琐碎修补（成本偏高）',
      '纯运维流水线机械操作（可交给更偏 devops 的 Agent）',
    ],
    tags: ['reason', 'architecture', 'review', 'implement', 'docs'],
  },
  codex: {
    summary: '短平快改码：局部 bugfix、单测失败、小范围搜索与补丁。',
    strengths: [
      '小范围 bug 定位与修复',
      '失败单测 / 类型错误的快速修补',
      '局部重构与小功能补丁',
      '代码库内快速搜索与核对',
    ],
    avoid: [
      '长篇架构综合与多仓库大改',
      '需要深度产品/设计讨论文档的任务',
    ],
    tags: ['code', 'fix', 'fast', 'tests'],
  },
  copilot: {
    summary: 'GitHub 生态编码：仓库上下文、PR/分支工作流、与 gh 协作的改动。',
    strengths: [
      '在 GitHub 仓库上下文中改代码',
      'PR / branch / review 相关辅助',
      '与 gh CLI 协作的开发任务',
      '常规应用层功能实现',
    ],
    avoid: [
      '非 GitHub 托管、无仓库上下文的纯调研',
      '重度系统架构综合（可交给 claude-code）',
    ],
    tags: ['github', 'pr', 'code', 'gh'],
  },
  opencode: {
    summary: '工程执行型：编码、git、测试、构建与常见 devops 操作。',
    strengths: [
      '日常编码与重构落地',
      'git 操作（commit/branch/rebase 辅助）',
      '测试编写、修复与覆盖',
      '构建 / 部署脚本与容器相关任务',
      '数据库与 API 实现向改动',
    ],
    avoid: [
      '纯概念解释且无需改代码（可交给 claude-code）',
      '与 OpenCode 无关的长文写作',
    ],
    tags: ['code', 'git', 'test', 'devops', 'build'],
  },
  antigravity: {
    summary: 'Google / Gemini 向：搜索综合、多模态线索、与 Google 工具链相关的任务。',
    strengths: [
      '需要广泛检索与综合的调研',
      '多模态线索（图文）相关辅助',
      'Google 生态工具链相关任务',
      '快速原型与思路探索',
    ],
    avoid: [
      '要求严格本地仓库大改且无 Gemini 优势的任务',
      '强依赖其他 CLI 专属工作流的作业',
    ],
    tags: ['gemini', 'research', 'multimodal', 'google'],
  },
  cursor: {
    summary: 'IDE/代码库感知编辑：基于项目上下文的定向修改与补全式实现。',
    strengths: [
      '在熟悉代码库中做定向编辑',
      '按文件/符号范围落地改动',
      '与 Cursor 工作区习惯一致的实现任务',
      '中等规模功能补丁',
    ],
    avoid: [
      '无代码库上下文的纯外部调研',
      '需要独立长推理综述而不改代码的任务',
    ],
    tags: ['ide', 'codebase', 'edit', 'implement'],
  },
  'kimi-code': {
    summary: '中文友好与长上下文编码：中文需求理解、长文档/大仓库阅读后的改码。',
    strengths: [
      '中文需求与中文代码注释场景',
      '长上下文阅读后的实现/摘要',
      '中等复杂度功能开发',
      '中英混合技术材料处理',
    ],
    avoid: [
      '强依赖其他厂商专属工具链的任务',
      '只需极短补丁且无长上下文需求的琐事',
    ],
    tags: ['zh', 'long-context', 'code', 'implement'],
  },
  qoder: {
    summary: '通用编码 Agent：功能实现、缺陷修复与常规工程改动。',
    strengths: [
      '常规功能开发与缺陷修复',
      '中小规模重构',
      '按任务说明落地补丁',
    ],
    avoid: [
      '需要深度架构评审的任务（可交给 claude-code）',
      '纯运维/发布流水线机械操作',
    ],
    tags: ['code', 'fix', 'implement'],
  },
  pi: {
    summary: '轻量会话与脚本向：短问答、小脚本、快速试探性改动。',
    strengths: [
      '短问答与小范围脚本',
      '快速试探、验证想法',
      '轻量文件编辑',
    ],
    avoid: [
      '重型多文件工程改造',
      '需要严格审批/沙箱策略的敏感生产变更',
    ],
    tags: ['light', 'script', 'explore'],
  },
  mimo: {
    summary: '通用编码 CLI：实现、修补与常规仓库内改动。',
    strengths: [
      '常规编码实现',
      '缺陷修复与小重构',
      '按 brief 交付可验证改动',
    ],
    avoid: [
      '需要强架构综合的评审任务',
      '无代码产出的长文研究',
    ],
    tags: ['code', 'fix', 'implement'],
  },
}

function cleanList(raw: unknown, max = 20): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (!s) continue
    out.push(s.slice(0, 200))
    if (out.length >= max) break
  }
  return out
}

export function normalizeAgentProfile(
  raw: Partial<AgentProfile> | null | undefined,
  fallback?: AgentProfile,
): AgentProfile {
  const base = fallback ?? { summary: '', strengths: [], avoid: [], tags: [] }
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim().slice(0, 500) : base.summary
  return {
    summary: summary || base.summary,
    strengths: raw?.strengths !== undefined ? cleanList(raw.strengths) : [...base.strengths],
    avoid: raw?.avoid !== undefined ? cleanList(raw.avoid) : [...base.avoid],
    tags: raw?.tags !== undefined ? cleanList(raw.tags, 20).map((t) => t.slice(0, 64)) : [...base.tags],
  }
}

export type AgentProfileOverrides = Record<string, Partial<AgentProfile>>

/** Merge builtin defaults with config overrides (canonical ids only). */
export function mergeAgentProfiles(
  overrides?: AgentProfileOverrides | null,
): Record<NonAgimAgentId, AgentProfile> {
  const out = {} as Record<NonAgimAgentId, AgentProfile>
  for (const id of NON_AGIM_AGENT_IDS) {
    const key = Object.keys(overrides || {}).find((k) => normalizeAgentId(k) === id)
    const over = key && overrides ? overrides[key] : undefined
    out[id] = normalizeAgentProfile(over, DEFAULT_AGENT_PROFILES[id])
  }
  return out
}

/** Persist only profiles that differ from builtin defaults. */
export function agentProfileOverridesFromEffective(
  effective: Record<string, AgentProfile>,
): AgentProfileOverrides {
  const out: AgentProfileOverrides = {}
  for (const id of NON_AGIM_AGENT_IDS) {
    const cur = effective[id]
    if (!cur) continue
    const def = DEFAULT_AGENT_PROFILES[id]
    if (profilesEqual(cur, def)) continue
    out[id] = {
      summary: cur.summary,
      strengths: [...cur.strengths],
      avoid: [...cur.avoid],
      tags: [...cur.tags],
    }
  }
  return out
}

export function profilesEqual(a: AgentProfile, b: AgentProfile): boolean {
  return (
    a.summary === b.summary
    && JSON.stringify(a.strengths) === JSON.stringify(b.strengths)
    && JSON.stringify(a.avoid) === JSON.stringify(b.avoid)
    && JSON.stringify(a.tags) === JSON.stringify(b.tags)
  )
}

/**
 * Compact catalog for system / tool prompts. Prefer enabled agents when
 * provided; always skip Agim (orchestrator, not a Subagent specialty).
 */
export function formatAgentProfilesForPrompt(
  profiles: Record<string, AgentProfile>,
  opts?: { enabledAgents?: string[]; maxAgents?: number },
): string {
  const enabled = new Set(
    (opts?.enabledAgents || [])
      .map((a) => normalizeAgentId(a))
      .filter((a) => a && !isAgimAgentId(a)),
  )
  const ids = NON_AGIM_AGENT_IDS.filter((id) => enabled.size === 0 || enabled.has(id))
  const capped = typeof opts?.maxAgents === 'number' ? ids.slice(0, opts.maxAgents) : ids
  if (capped.length === 0) return ''

  const lines: string[] = [
    'CLI Subagent specialty catalog (pick agent= by fit; Agim remains the parent):',
  ]
  for (const id of capped) {
    const p = profiles[id] || DEFAULT_AGENT_PROFILES[id]
    if (!p) continue
    const strengths = p.strengths.slice(0, 3).join('; ')
    const avoid = p.avoid.slice(0, 2).join('; ')
    lines.push(
      `- ${id}: ${p.summary}`
        + (strengths ? ` | good at: ${strengths}` : '')
        + (avoid ? ` | avoid: ${avoid}` : '')
        + (p.tags.length ? ` | tags: ${p.tags.slice(0, 6).join(',')}` : ''),
    )
  }
  return lines.join('\n')
}

/** Load overrides from a Config-like object. */
export function readAgentProfileOverrides(config: unknown): AgentProfileOverrides {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const raw = (config as { agentProfiles?: unknown }).agentProfiles
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: AgentProfileOverrides = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const id = normalizeAgentId(key)
    if (!isNonAgimAgentId(id)) continue
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue
    out[id] = val as Partial<AgentProfile>
  }
  return out
}

export function resolveAgentProfiles(config?: unknown): Record<NonAgimAgentId, AgentProfile> {
  return mergeAgentProfiles(readAgentProfileOverrides(config))
}

/** Live catalog string for Agim system / tool prompts (best-effort). */
export function getAgentProfilesCatalogForPrompt(): string {
  try {
    const cfg = getLiveConfig()
    const profiles = resolveAgentProfiles(cfg)
    return formatAgentProfilesForPrompt(profiles, {
      enabledAgents: cfg?.agents,
    })
  } catch {
    return formatAgentProfilesForPrompt(mergeAgentProfiles())
  }
}
