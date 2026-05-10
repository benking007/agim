// Built-in commands: /start /status /help /agents /new
//
// /help and /start are i18n-aware (default zh, /help en or /start en for English).
// /help also accepts a topic: /help remind, /help cron, /help job, /help approval,
// /help workspaces, /help model, /help think, /help stats, /help sessions, /help plan.

import type { RouteContext } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'
import { handleRemindCommand } from './remind.js'

type Lang = 'zh' | 'en'

const EN_TOKENS = new Set(['en', 'english', 'eng', '英文', 'english:'])
const ZH_TOKENS = new Set(['zh', 'cn', 'chinese', '中文', '中', 'cn:', 'zh-cn'])

/** Strip a leading lang token if present, returning {lang, rest}. Default zh. */
function detectLang(args: string | undefined): { lang: Lang; rest: string } {
  const raw = (args ?? '').trim()
  if (!raw) return { lang: 'zh', rest: '' }
  const head = raw.split(/\s+/)[0].toLowerCase()
  if (EN_TOKENS.has(head)) return { lang: 'en', rest: raw.slice(head.length).trim() }
  if (ZH_TOKENS.has(head)) return { lang: 'zh', rest: raw.slice(head.length).trim() }
  return { lang: 'zh', rest: raw }
}

const HELP_ZH = [
  'im-hub 命令速查',
  '会话: /new  /agents  /[agent] [内容]',
  '提醒: /remind …（一次性/周期/邮件，中文 NL 时间）',
  '定时: /cron …（cron 跑 agent，旧名 /schedule 仍可）',
  '任务: /job  /tasks  /check  /cancel  /switch  /collect',
  'Agent: /model  /models  /think on|off  /plan on|off',
  '审批: /approval（别名 /auto），卡片回 y/n/all',
  '运维: /status  /audit  /stats  /sessions  /workspaces  /router',
  '转 agent: /test  /review  /commit  /push  /diff  /shell  /bug  /explain',
  '详情: /help [命令]   英文: /help en',
].join('\n')

const HELP_EN = [
  'im-hub Commands',
  'Session: /new  /agents  /[agent] [prompt]',
  'Remind: /remind … (one-shot/recurring/email · NL time)',
  'Cron: /cron … (cron-driven agent; legacy /schedule works)',
  'Jobs: /job  /tasks  /check  /cancel  /switch  /collect',
  'Agent: /model  /models  /think on|off  /plan on|off',
  'Approval: /approval (alias /auto) · card reply y/n/all',
  'Ops: /status  /audit  /stats  /sessions  /workspaces  /router',
  'Forward: /test  /review  /commit  /push  /diff  /shell  /bug  /explain',
  'Details: /help [cmd]   中文: /help zh',
].join('\n')

// Topic-help section separator. Plain ASCII — non-ASCII line-drawing
// characters (─) seem to confuse iLink/WeChat reflow on some messages.
const SEP = '---'

const START_ZH = [
  '欢迎使用 im-hub',
  '我是你的 AI 助手中枢——发消息我就路由给合适的 agent。',
  '/help      命令速查',
  '/agents    可用 agent',
  '/help en   switch to English',
].join('\n')

const START_EN = [
  'Welcome to im-hub',
  "I'm your AI assistant hub — send a message and I'll route it to the right agent.",
  '/help      command reference',
  '/agents    available agents',
  '/help zh   切换中文',
].join('\n')

/** Brief help for commands that don't have their own help subcommand. */
const TOPIC_HELP_ZH: Record<string, string> = {
  cron: [
    '/cron — cron 表达式驱动 agent 跑预设 prompt',
    SEP,
    '/cron list                                       列出我的定时任务',
    '/cron create <name> <agent> "<cron>" <prompt>    创建',
    '/cron check <id>                                 详情',
    '/cron enable|disable <id>                        启停',
    '/cron delete <id>                                删除',
    SEP,
    '例: /cron create daily-report opencode "0 9 * * 1-5" 生成销售日报',
    'cron 5 字段: 分 时 日 月 周 (POSIX)',
    '旧名 /schedule 仍可用 (v0.4.0 移除)',
  ].join('\n'),
  job: [
    '/job — 后台长任务 (基于 job-board)',
    SEP,
    '/job create <agent> <prompt>          创建任务',
    '/job list   (/tasks)                  列我的任务',
    '/job check <id>   (/check <id>)       看进度/结果',
    '/job cancel <id>  (/cancel <id>)      取消',
    '/job switch <id>  (/switch <id>)      把当前会话切到任务',
    '/job collect <id> (/collect <id>)     拉一次结果',
  ].join('\n'),
  approval: [
    '/approval (别名 /auto) — 工具调用审批规则',
    SEP,
    '/approval         列出本会话当前的自动放行规则',
    '/approval clear   清空',
    SEP,
    '审批卡片回复',
    'y 同意 · n 拒绝 · all 本会话同类自动放行',
    '(5 分钟未回 = 拒绝)',
  ].join('\n'),
  workspaces: [
    '/workspaces (别名 /ws) — workspace 管理',
    SEP,
    '/ws list           列所有 workspace',
    '/ws current        看当前',
    '/ws use <name>     切换',
  ].join('\n'),
  ws: '见 /help workspaces',
  model: [
    '/model — 查或切当前 agent 的模型',
    SEP,
    '/model                       看当前',
    '/model <provider/model>      切换',
    '/models                      列所有可用',
  ].join('\n'),
  think: '/think on|off — 切换 extended thinking (深度思考)',
  stats: '/stats — 用量统计 (别名 /usage /cost)',
  sessions: '/sessions — 列出最近的会话',
  plan: '/plan on|off — 切换 plan 模式 (agent 只能读、不能写/执行)',
  router: '/router status|explain — 看路由决策 (哪条 agent、为什么)',
  audit: '/audit [n] — 看最近 n 条调用记录',
  agents: '/agents — 列出已注册的 agent',
  new: '/new — 开新会话 (清当前 thread 的上下文)',
  status: '/status — 连接状态',
}

const TOPIC_HELP_EN: Record<string, string> = {
  cron: [
    '/cron — cron-driven scheduled agent runs',
    SEP,
    '/cron list                                       list your schedules',
    '/cron create <name> <agent> "<cron>" <prompt>    create',
    '/cron check <id>                                 details',
    '/cron enable|disable <id>                        toggle',
    '/cron delete <id>                                remove',
    SEP,
    'Example: /cron create daily-report opencode "0 9 * * 1-5" Generate today\'s report',
    'cron: 5-field POSIX format (min hour dom mon dow)',
    'Legacy /schedule alias still works (removed in v0.4.0)',
  ].join('\n'),
  job: [
    '/job — background long-running tasks',
    SEP,
    '/job create <agent> <prompt>          create',
    '/job list   (/tasks)                  list yours',
    '/job check <id>   (/check <id>)       inspect',
    '/job cancel <id>  (/cancel <id>)      cancel',
    '/job switch <id>  (/switch <id>)      switch session to that job',
    '/job collect <id> (/collect <id>)     collect once',
  ].join('\n'),
  approval: [
    '/approval (alias /auto) — tool-call approval rules',
    SEP,
    '/approval         list current auto-allow rules in this session',
    '/approval clear   clear them',
    SEP,
    'Approval card replies',
    'y allow · n deny · all auto-allow same kind in this session',
    '(5 min no reply = deny)',
  ].join('\n'),
  workspaces: [
    '/workspaces (alias /ws) — workspace management',
    SEP,
    '/ws list           list all',
    '/ws current        show current',
    '/ws use <name>     switch',
  ].join('\n'),
  ws: 'see /help workspaces',
  model: [
    '/model — view or switch the active agent\'s model',
    SEP,
    '/model                       show current',
    '/model <provider/model>      switch',
    '/models                      list available',
  ].join('\n'),
  think: '/think on|off — toggle extended thinking',
  stats: '/stats — usage stats (aliases /usage /cost)',
  sessions: '/sessions — list recent sessions',
  plan: '/plan on|off — toggle plan (read-only) mode',
  router: '/router status|explain — show routing decisions',
  audit: '/audit [n] — show last n invocations',
  agents: '/agents — list registered agents',
  new: '/new — start a new conversation (clear current thread\'s context)',
  status: '/status — connectivity status',
}

/** Topics that delegate to the command's own `help` subcommand. */
async function delegatedTopic(topic: string, ctx: RouteContext): Promise<string | null> {
  if (topic === 'remind' || topic === 'reminder') {
    return handleRemindCommand('help', ctx)
  }
  return null
}

export async function handleBuiltInCommand(
  command: 'start' | 'status' | 'help' | 'agents' | 'new',
  ctx: RouteContext,
  args?: string,
): Promise<string> {
  switch (command) {
    case 'start': {
      const { lang } = detectLang(args)
      return lang === 'en' ? START_EN : START_ZH
    }

    case 'status':
      return `📊 IM hub Status\n\nPlatform: Connected\nAgent: Ready\n\nSend a message to start!`

    case 'help': {
      const { lang, rest } = detectLang(args)
      const topic = rest.split(/\s+/)[0]?.toLowerCase().replace(/^\//, '') || ''
      if (!topic) return lang === 'en' ? HELP_EN : HELP_ZH
      const delegated = await delegatedTopic(topic, ctx)
      if (delegated) return delegated
      const dict = lang === 'en' ? TOPIC_HELP_EN : TOPIC_HELP_ZH
      const body = dict[topic]
      if (body) return body
      const unknown = lang === 'en'
        ? `Unknown topic "${topic}". Try \`/help\` for the full list.`
        : `没有 \`${topic}\` 这个主题。试试 \`/help\` 看完整列表。`
      return unknown
    }

    case 'agents': {
      const agents = registry.listAgents()
      if (agents.length === 0) {
        return '⚠️ No agents registered yet.'
      }
      return `🤖 Available Agents\n\n${agents.map(a => `• ${a}`).join('\n')}\n\nUse /<agent> to switch.`
    }

    case 'new': {
      const session = await sessionManager.resetConversation(ctx.platform, ctx.channelId, ctx.threadId)
      if (session) {
        return `🆕 New conversation started with ${session.agent}.\n\nPrevious context has been cleared.`
      }
      return `🆕 Ready to start a new conversation.\n\nSend a message to begin.`
    }
  }
}
