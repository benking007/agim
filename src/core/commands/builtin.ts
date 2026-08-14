// Built-in commands: /start /status /help /agents /new
//
// /help and /start are i18n-aware (default zh, /help en or /start en for English).
// /help also accepts a topic: /help remind, /help cron, /help job, /help approval,
// /help workspaces, /help model, /help think, /help stats, /help sessions, /help plan.
// Topic aliases (`/help tasks` → job, `/help auto` → approval, etc.) are resolved
// via TOPIC_ALIAS before delegation/dict lookup.

import { isAgimAgentId } from '../naming-migrate.js'
import type { RouteContext } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'
import { handleRemindCommand } from './remind.js'
import { handleMemoCommand } from './memo.js'

type Lang = 'zh' | 'en'

const EN_TOKENS = new Set(['en', 'english', 'eng', '英文'])
const ZH_TOKENS = new Set(['zh', 'cn', 'chinese', '中文', '中', 'zh-cn'])

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
  'agim 命令速查',
  '',
  '/new          开新会话',
  '/agents       列出可用 agent',
  '/[agent]      向指定 agent 发消息（如 /cc /agim）',
  '/help [cmd]   查看帮助（/help en 英文）',
  '/remind …     提醒（一次性/周期/邮件）',
  '/memo …       5W1H 持久记录（自然语言交给 agent 自动拆解）',
  '/cron …       定时跑 agent（旧名 /schedule）',
  '/focus …      本线程聚焦（注入 / on / off）',
  '/loop …       开发闭环（路径 A/B；需 Focus 或 /loop <text> 代开）',
  '/job          后台长任务管理',
  '/tasks        列出我的任务',
  '/check <id>   查看任务进度',
  '/cancel <id>  取消任务',
  '/switch <id>  切换会话到任务',
  '/collect <id> 拉取结果',
  '/model        查看或切换模型',
  '/models       列出可用模型',
  '/think on|off 切换深度思考',
  '/ctx auto|full|balanced|frequent 会话压缩率（别名 /压缩率）',
  '/plan on|off  切换 plan 模式',
  '/step-reflect on|off  执行过程（默认开；每步先思考再行动；仅 Agim）',
  '/approval     审批规则（别名 /auto）',
  '/abort        中止当前 agent 任务（别名：纯文本 stop / 停止 / 中止 / esc）',
  '/btw <问题>   旁路快答（绕开主会话队列，开独立小线程）',
  '/status       服务状态（uptime/agent/messengers）',
  '/web          Web 后台地址（别名 /console /url）',
  '/restart      重启服务（仅 admin，可直接说"重启服务"）',
  '/stop         停止服务（仅 admin）',
  '/setup        兼容提示：IM 管理员请在 Web「设置→管理员」配置',
  '/audit [n]    查看调用记录',
  '/stats        用量统计（/usage /cost）',
  '/sessions     最近会话',
  '/workspaces   工作区管理（别名 /ws）',
  '/router       查看路由决策',
  '/test         -> agent: 测试',
  '/review       -> agent: 审查',
  '/commit       -> agent: 提交',
  '/push         -> agent: 推送',
  '/diff         -> agent: 差异',
  '/shell        -> agent: shell',
  '/bug          -> agent: bug',
  '/explain      -> agent: 解释',
].join('\n')

const HELP_EN = [
  'agim Commands',
  '',
  '/new          start a new session',
  '/agents       list available agents (kind tag: [cli]=bridged CLI / [in-process]=agim)',
  '/[agent]      send message to agent (/cc claude / /cx codex / /oc opencode / /agim …)',
  '/help [cmd]   show help (/help zh for Chinese)',
  '/remind …     reminders (one-shot/recurring/email)',
  '/memo …       5W1H persistent memos (let agent parse natural language)',
  '/cron …       scheduled agent runs (legacy /schedule)',
  '/focus …      per-thread Focus (inject / on / off)',
  '/loop …       development loop (path A/B; needs Focus or /loop <text>)',
  '/job          manage background jobs',
  '/tasks        list your jobs',
  '/check <id>   inspect job progress',
  '/cancel <id>  cancel a job',
  '/switch <id>  switch session to job',
  '/collect <id> collect job result',
  '/model        view or switch model',
  '/models       list available models',
  '/think on|off toggle extended thinking',
  '/ctx auto|full|balanced|frequent session compression rate',
  '/plan on|off  toggle plan mode',
  '/step-reflect on|off  step-think each hop, then act (default on; Agim only)',
  '/approval     tool approval rules (alias /auto)',
  '/abort        abort the running agent run (aliases: plain "stop" / "停止" / "中止" / "esc")',
  '/btw <q>      by-the-way side question (bypasses thread queue; opens a tiny scratch sub-thread)',
  '/status       service status (uptime / agent / messengers)',
  '/web          show web console URL (aliases /console /url)',
  '/restart      restart service (admin only — or just say "restart service")',
  '/stop         stop service (admin only)',
  '/setup        compatibility hint: configure IM admins in Web Settings',
  '/audit [n]    show invocations',
  '/stats        usage stats (/usage /cost)',
  '/sessions     list recent sessions',
  '/workspaces   workspace management (alias /ws)',
  '/router       show routing decisions',
  '/test         -> agent: test',
  '/review       -> agent: review',
  '/commit       -> agent: commit',
  '/push         -> agent: push',
  '/diff         -> agent: diff',
  '/shell        -> agent: shell',
  '/bug          -> agent: bug',
  '/explain      -> agent: explain',
].join('\n')

// Topic-help section separator. Plain ASCII — non-ASCII line-drawing
// characters (─) seem to confuse iLink/WeChat reflow on some messages.
const SEP = '---'

const START_ZH = [
  '欢迎使用 agim',
  '我是你的 AI 助手中枢——发消息我就路由给合适的 agent。',
  '/help      命令速查',
  '/agents    可用 agent',
  '/help en   switch to English',
].join('\n')

const START_EN = [
  'Welcome to agim',
  "I'm your AI assistant hub — send a message and I'll route it to the right agent.",
  '/help      command reference',
  '/agents    available agents',
  '/help zh   切换中文',
].join('\n')

/**
 * Topic-name aliases — resolved to canonical names BEFORE delegation/dict lookup.
 * Lets `/help tasks` show the same content as `/help job`, etc. Slash-command
 * aliases (`/tasks`, `/auto`, `/ws`, `/reminder`) are listed in the master HELP
 * but had no per-topic detail before this map.
 */
const TOPIC_ALIAS: Record<string, string> = {
  reminder: 'remind',
  tasks: 'job',
  check: 'job',
  cancel: 'job',
  switch: 'job',
  collect: 'job',
  auto: 'approval',
  models: 'model',
  ws: 'workspaces',
  '记': 'memo',
  note: 'memo',
  '步思': 'step-reflect',
  '一步一想': 'step-reflect',
  '执行过程': 'step-reflect',
}

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
    '(超时默认行为见 Web 设置 → 审批策略)',
  ].join('\n'),
  workspaces: [
    '/workspaces (别名 /ws) — workspace 管理',
    SEP,
    '/ws list           列所有 workspace',
    '/ws current        看当前',
    '/ws use <name>     切换',
  ].join('\n'),
  model: [
    '/model — 查或切当前 agent 的模型',
    SEP,
    '/model                       看当前',
    '/model <模型或后端名>        切换',
    '/model reset                 恢复默认',
    '/models                      列所有可用',
    '/models <关键词>             过滤',
    '/models refresh              刷新缓存',
    SEP,
    '注：Agim Agent(native) 使用大模型 API 后端名；opencode / pi / mimo 使用 provider/model；cursor / kimi / qoder / copilot 使用各自 CLI 模型名。',
  ].join('\n'),
  think: '/think on|off — 切换 extended thinking (深度思考)',
  ctx: '/ctx auto|full|balanced|frequent — 本会话压缩率（自动/满压/均衡/频繁）',
  stats: '/stats — 用量统计 (别名 /usage /cost)',
  sessions: '/sessions — 列出最近的会话',
  plan: '/plan on|off — 切换 plan 模式 (agent 只能读、不能写/执行)',
  'step-reflect': '/step-reflect on|off — 执行过程（默认开；每步先思考再调工具，过程中持续反馈；仅 Agim）',
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
    '(timeout policy: see Web Settings → Approval Policy)',
  ].join('\n'),
  workspaces: [
    '/workspaces (alias /ws) — workspace management',
    SEP,
    '/ws list           list all',
    '/ws current        show current',
    '/ws use <name>     switch',
  ].join('\n'),
  model: [
    '/model — view or switch the active agent\'s model',
    SEP,
    '/model                       show current',
    '/model <model-or-backend>    switch',
    '/model reset                 restore default',
    '/models                      list available',
    '/models <filter>             filter list',
    '/models refresh              refresh cache',
    SEP,
    'Note: Agim Agent(native) uses model API backend names; opencode / pi / mimo use provider/model; cursor / kimi / qoder / copilot use their own CLI model names.',
  ].join('\n'),
  think: '/think on|off — toggle extended thinking',
  ctx: '/ctx auto|full|balanced|frequent — session compression rate',
  stats: '/stats — usage stats (aliases /usage /cost)',
  sessions: '/sessions — list recent sessions',
  plan: '/plan on|off — toggle plan (read-only) mode',
  'step-reflect': '/step-reflect on|off — think each hop, then call tools (default on; Agim only)',
  router: '/router status|explain — show routing decisions',
  audit: '/audit [n] — show last n invocations',
  agents: '/agents — list registered agents',
  new: '/new — start a new conversation (clear current thread\'s context)',
  status: '/status — connectivity status',
}

/** Topics that delegate to the command's own `help` subcommand. Topic is canonical
 *  here — aliases (e.g. 'reminder') are resolved by TOPIC_ALIAS before this runs. */
async function delegatedTopic(topic: string, ctx: RouteContext): Promise<string | null> {
  if (topic === 'remind') {
    return handleRemindCommand('help', ctx)
  }
  if (topic === 'memo') {
    return handleMemoCommand('help', ctx)
  }
  return null
}

export async function handleBuiltInCommand(
  command: 'start' | 'help' | 'agents' | 'new',
  ctx: RouteContext,
  args?: string,
): Promise<string> {
  switch (command) {
    case 'start': {
      const { lang } = detectLang(args)
      return lang === 'en' ? START_EN : START_ZH
    }

    case 'help': {
      const { lang, rest } = detectLang(args)
      const raw = rest.split(/\s+/)[0]?.toLowerCase().replace(/^\//, '') || ''
      if (!raw) return lang === 'en' ? HELP_EN : HELP_ZH
      const topic = TOPIC_ALIAS[raw] ?? raw
      const delegated = await delegatedTopic(topic, ctx)
      if (delegated) return delegated
      const dict = lang === 'en' ? TOPIC_HELP_EN : TOPIC_HELP_ZH
      const body = dict[topic]
      if (body) return body
      const unknown = lang === 'en'
        ? `Unknown topic "${raw}". Try \`/help\` for the full list.`
        : `没有 \`${raw}\` 这个主题。试试 \`/help\` 看完整列表。`
      return unknown
    }

    case 'agents': {
      const names = registry.listAgents()
      if (names.length === 0) {
        return '⚠️ No agents registered yet.'
      }
      // Stage 6 (native-as-peer follow-up) — render each agent with its
      // implementation kind tag + optional `describe()` summary so the
      // user can see CLI vs in-process vs remote without opening docs.
      // Native agent is just another row here — by design — matching
      // the 'every backend is a peer AgentAdapter' architectural stance.
      const lines = names.map((name) => {
        const adapter = registry.findAgent(name)
        if (!adapter) return `• ${name}`
        const kind = adapter.kind ?? 'cli'
        const flag = ({ cli: '[cli]', 'in-process': '[in-process]' })[kind] ?? `[${kind}]`
        const displayName = isAgimAgentId(name) ? 'Agim Agent' : name
        const aliasSet = new Set<string>()
        if (isAgimAgentId(name)) { aliasSet.add('agim'); aliasSet.add('native') }
        for (const a of adapter.aliases) {
          if (a !== displayName) aliasSet.add(a)
        }
        const aliases = aliasSet.size > 0 ? ` (${Array.from(aliasSet).map((a) => `/${a}`).join(', ')})` : ''
        const summary = typeof adapter.describe === 'function' ? adapter.describe() : undefined
        const summaryStr = summary ? ` — ${summary}` : ''
        return `• /${displayName} ${flag}${aliases}${summaryStr}`
      })
      return `🤖 Available Agents\n\n${lines.join('\n')}\n\nUse /<agent> or its alias to switch.`
    }

    case 'new': {
      const session = await sessionManager.resetConversation(ctx.platform, ctx.channelId, ctx.threadId)
      if (session) {
        const displayAgent = isAgimAgentId(session.agent) ? 'Agim Agent' : session.agent
        return `🆕 New conversation started with ${displayAgent}.\n\nPrevious context has been cleared.`
      }
      return `🆕 Ready to start a new conversation.\n\nSend a message to begin.`
    }
  }
}
