/**
 * Portal slash-command registry for the `/` composer picker.
 * High-priority: Plan, Memo, Focus, Loop, Subagent, Remember, Models.
 */

export type PortalSlashAction =
  | { type: 'fill'; text: string }
  | { type: 'send'; text: string }
  | { type: 'toggle-plan' }

export interface PortalSlashCommand {
  id: string
  /** Display label in the picker (e.g. "Plan"). */
  label: string
  /** Short description under the label (optional). */
  description?: string
  /** Filter tokens (lowercase). */
  keywords: string[]
  /** Priority: lower = higher in the list. High-priority ids use 0–6. */
  priority: number
  action: PortalSlashAction
}

/** Commands shown first in the `/` popup (and prioritized in "more"). */
export const PRIORITY_COMMAND_IDS = [
  'plan',
  'memo',
  'focus',
  'loop',
  'subagent',
  'remember',
  'models',
] as const

/** Composer fill that steers the agent to spawn Subagent(s). */
export const SUBAGENT_COMPOSER_FILL =
  '请用子代理（call_agent / call_agents）完成（要求子代理最终消息含关键发现；若落盘须写明绝对路径；禁止只有「见上文」）：'

export const PORTAL_SLASH_COMMANDS: PortalSlashCommand[] = [
  {
    id: 'plan',
    label: 'Plan',
    description: 'Generate an implementation plan',
    keywords: ['plan', '规划', '计划'],
    priority: 0,
    action: { type: 'toggle-plan' },
  },
  {
    id: 'memo',
    label: 'Memo',
    description: 'Save a 5W1H memo',
    keywords: ['memo', '备忘', '记录'],
    priority: 1,
    action: { type: 'fill', text: '/memo here' },
  },
  {
    id: 'focus',
    label: 'Focus',
    description: 'Set attention focus (on/off)',
    keywords: ['focus', '聚焦', 'goal', '目标'],
    priority: 2,
    action: { type: 'fill', text: '/focus ' },
  },
  {
    id: 'loop',
    label: 'Loop',
    description: 'Loop Engineering — align → dispatch → verify',
    keywords: ['loop', '循环', '闭环', 'engineering'],
    priority: 3,
    action: { type: 'fill', text: '/loop ' },
  },
  {
    id: 'cronloop',
    label: 'Cronloop',
    description: 'Schedule a Loop (confirm in the bottom dock)',
    keywords: ['cronloop', 'cornloop', '定时loop', '定时闭环', 'scheduled'],
    priority: 7,
    action: { type: 'send', text: '/cronloop' },
  },
  {
    id: 'subagent',
    label: 'Subagent',
    description: 'Ask the agent to spawn a Subagent',
    keywords: ['subagent', '子代理', 'call_agent', 'call_agents', '并行'],
    priority: 4,
    action: { type: 'fill', text: SUBAGENT_COMPOSER_FILL },
  },
  {
    id: 'remember',
    label: 'Remember',
    description: 'Set a reminder',
    keywords: ['remember', 'remind', '提醒', 'reminder'],
    priority: 5,
    action: { type: 'fill', text: '/remind ' },
  },
  {
    id: 'models',
    label: 'Models',
    description: 'List available models',
    keywords: ['models', 'model', '模型'],
    priority: 6,
    action: { type: 'send', text: '/models' },
  },
  {
    id: 'new',
    label: 'New',
    description: 'Start a new conversation',
    keywords: ['new', '新会话'],
    priority: 20,
    action: { type: 'send', text: '/new' },
  },
  {
    id: 'help',
    label: 'Help',
    description: 'Show command help',
    keywords: ['help', '帮助'],
    priority: 21,
    action: { type: 'send', text: '/help' },
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'List available agents',
    keywords: ['agents', 'agent'],
    priority: 22,
    action: { type: 'send', text: '/agents' },
  },
  {
    id: 'status',
    label: 'Status',
    description: 'Service status',
    keywords: ['status', '状态'],
    priority: 23,
    action: { type: 'send', text: '/status' },
  },
  {
    id: 'think',
    label: 'Think',
    description: 'Toggle extended thinking',
    keywords: ['think', '思考'],
    priority: 24,
    action: { type: 'fill', text: '/think ' },
  },
  {
    id: 'skill',
    label: 'Skill',
    description: 'List or show skills',
    keywords: ['skill', 'skills'],
    priority: 25,
    action: { type: 'fill', text: '/skill ' },
  },
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'Recent sessions',
    keywords: ['sessions', '会话'],
    priority: 26,
    action: { type: 'send', text: '/sessions' },
  },
  {
    id: 'stats',
    label: 'Stats',
    description: 'Usage statistics',
    keywords: ['stats', 'usage', 'cost', '统计'],
    priority: 27,
    action: { type: 'send', text: '/stats' },
  },
  {
    id: 'abort',
    label: 'Abort',
    description: 'Abort the current run',
    keywords: ['abort', 'stop', '中止'],
    priority: 28,
    action: { type: 'send', text: '/abort' },
  },
]

const USAGE_KEY = 'agim.portal.slashUsage'

function readUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, number>
  } catch {
    return {}
  }
}

export function bumpSlashUsage(id: string): void {
  try {
    const map = readUsage()
    map[id] = (map[id] ?? 0) + 1
    localStorage.setItem(USAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota / private mode */
  }
}

export function filterSlashCommands(query: string): PortalSlashCommand[] {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  const usage = readUsage()
  const list = PORTAL_SLASH_COMMANDS.filter((c) => {
    if (!q) return true
    if (c.label.toLowerCase().startsWith(q)) return true
    if (c.id.startsWith(q)) return true
    return c.keywords.some((k) => k.startsWith(q) || k.includes(q))
  })
  return list.sort((a, b) => {
    const ua = usage[a.id] ?? 0
    const ub = usage[b.id] ?? 0
    if (ua !== ub) return ub - ua
    return a.priority - b.priority
  })
}

const SKILL_USAGE_KEY = 'agim.portal.skillUsage'

function readSkillUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SKILL_USAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, number>
  } catch {
    return {}
  }
}

export function bumpSkillUsage(name: string): void {
  try {
    const map = readSkillUsage()
    map[name] = (map[name] ?? 0) + 1
    localStorage.setItem(SKILL_USAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export interface PortalSkillItem {
  name: string
  description: string
}

export function sortSkillsByUsage(skills: PortalSkillItem[]): PortalSkillItem[] {
  const usage = readSkillUsage()
  return [...skills].sort((a, b) => {
    const ua = usage[a.name] ?? 0
    const ub = usage[b.name] ?? 0
    if (ua !== ub) return ub - ua
    return a.name.localeCompare(b.name)
  })
}

/** Markers embedded in the sent message (and rendered as chips). */
export function skillMarker(name: string): string {
  return `[技能：${name}]`
}

export function workspaceMarker(): string {
  return '[工作区]'
}

export function workspaceFileMarker(relPath: string, isDir: boolean): string {
  const tag = isDir ? '工作区目录' : '工作区文件'
  return `[${tag}：${relPath}]`
}
