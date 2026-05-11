// cli-ui/i18n.ts — string dictionaries + persistent language preference
// for the interactive CLI wizard (im-hub-pro / im-hub-pro config / status / etc.).
//
// Pattern mirrors imhub-site's strings.ts: the EN dict drives the Key type,
// the ZH dict is `Record<Key, string>` so missing keys are a compile error.
//
// Language preference is persisted to ~/.im-hub/cli-lang (single-line file
// containing "en" or "zh"). First-run users get a language picker; later
// runs default to the saved choice (Enter accepts).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Lang = 'en' | 'zh'

const PREF_FILE = join(homedir(), '.im-hub', 'cli-lang')

const en = {
  // ─── language picker ─────────────────────────────────────────────────
  'lang.pick': 'Select language / 选择界面语言',
  'lang.label.en': 'English',
  'lang.label.zh': '中文',
  'lang.saved': 'Language preference saved to {file}',

  // ─── entry menu (bare `im-hub-pro`) ──────────────────────────────────
  'menu.title': 'im-hub-pro · maintenance entry',
  'menu.subtitle': 'What would you like to do?',
  'menu.config': 'Configure (messengers, agents, SMTP, Baidu Maps …)',
  'menu.status': 'Show service status',
  'menu.start': 'Start the service (foreground)',
  'menu.start_bg': 'Start the service (background)',
  'menu.restart': 'Restart the service',
  'menu.stop': 'Stop the service',
  'menu.uninstall': 'Uninstall im-hub-pro (keeps workspaces)',
  'menu.quit': 'Quit',

  // ─── config root ─────────────────────────────────────────────────────
  'config.title': 'im-hub-pro · config',
  'config.subtitle': 'Pick a section to edit. Each section has a Back option.',
  'config.section.messengers': 'Messengers (WeChat / Telegram / Feishu / Discord / Email)',
  'config.section.agents': 'AI agents (Claude Code / OpenCode / Codex / Copilot)',
  'config.section.acp': 'Remote ACP agents',
  'config.section.smtp': 'SMTP — email reminder delivery',
  'config.section.baidu': 'Baidu Maps AK — /memo address geocoding',
  'config.section.done': 'Done — save and exit',
  'config.saved': 'Config saved to {file}',

  // ─── messengers ──────────────────────────────────────────────────────
  'messengers.pick': 'Toggle messengers (Space = on/off, Enter = confirm)',
  'messengers.hint.wechat': 'WeChat (iLink bot) — QR-code login',
  'messengers.hint.telegram': 'Telegram — bot token from @BotFather',
  'messengers.hint.feishu': 'Feishu / Lark — app ID + secret',
  'messengers.hint.discord': 'Discord — bot token (Discord developer portal)',
  'messengers.hint.email': 'Email (SMTP, push-only)',

  // ─── agents ──────────────────────────────────────────────────────────
  'agents.pick': 'Toggle agents (Space = on/off, Enter = confirm)',
  'agents.default': 'Default agent (used when no /prefix)',
  'agents.hint.claude': 'Claude Code (must be installed: `claude --version`)',
  'agents.hint.opencode': 'OpenCode (must be installed: `opencode --version`)',
  'agents.hint.codex': 'Codex (must be installed: `codex --version`)',
  'agents.hint.copilot': 'GitHub Copilot CLI',

  // ─── ACP agents ──────────────────────────────────────────────────────
  'acp.title': 'Remote ACP agents',
  'acp.subtitle': 'HTTP agents exposed via ACP. Add, edit, or remove.',
  'acp.action.add': 'Add a new agent',
  'acp.action.edit': 'Edit {name}',
  'acp.action.remove': 'Remove {name}',
  'acp.action.back': '← Back',
  'acp.field.name': 'Agent name (used as /prefix)',
  'acp.field.endpoint': 'Endpoint URL (e.g. https://api.example.com)',
  'acp.field.auth_type': 'Auth type',
  'acp.field.auth_token': 'Bearer token',
  'acp.auth.none': 'None (public endpoint)',
  'acp.auth.bearer': 'Bearer token',
  'acp.added': 'Added agent: {name}',
  'acp.removed': 'Removed agent: {name}',

  // ─── SMTP ────────────────────────────────────────────────────────────
  'smtp.title': 'SMTP (for /remind email delivery)',
  'smtp.subtitle': 'These end up in ~/.im-hub/env (chmod 600). Skip if email is not used.',
  'smtp.preset': 'Pick a preset or Custom',
  'smtp.preset.gmail': 'Gmail (smtp.gmail.com:465, requires App Password)',
  'smtp.preset.outlook': 'Outlook (smtp.office365.com:587)',
  'smtp.preset.qq': 'QQ Mail (smtp.qq.com:465, requires authorization code)',
  'smtp.preset.163': '163 Mail (smtp.163.com:465, requires authorization code)',
  'smtp.preset.custom': 'Custom SMTP server',
  'smtp.preset.skip': 'Skip — disable SMTP',
  'smtp.field.host': 'SMTP host',
  'smtp.field.port': 'SMTP port',
  'smtp.field.user': 'SMTP user (login email)',
  'smtp.field.pass': 'SMTP password / app password (hidden)',
  'smtp.field.from': 'From address (Enter = same as user)',
  'smtp.field.secure': 'TLS mode',
  'smtp.secure.auto': 'auto (recommended)',
  'smtp.secure.true': 'true (SSL on connect, e.g. port 465)',
  'smtp.secure.false': 'false (STARTTLS, e.g. port 587)',
  'smtp.saved': 'SMTP credentials saved to {file} (chmod 600)',
  'smtp.cleared': 'SMTP disabled — cleared {file}',

  // ─── Baidu Maps AK ───────────────────────────────────────────────────
  'baidu.title': 'Baidu Maps AK (for /memo address geocoding)',
  'baidu.subtitle': 'Optional — without it, /memo still works with raw coords + browser GPS.',
  'baidu.howto': 'Get a free AK: https://lbsyun.baidu.com → Console → 应用管理 → 创建应用 → 服务端 API',
  'baidu.action.set': 'Set / update AK',
  'baidu.action.clear': 'Clear AK (disable geocoding)',
  'baidu.action.back': '← Back',
  'baidu.input': 'Paste AK (32-char string starting with non-digit, leave blank to skip)',
  'baidu.saved': 'Baidu Maps AK saved to {file}',
  'baidu.cleared': 'Baidu Maps AK cleared',

  // ─── service mgmt ────────────────────────────────────────────────────
  'svc.status.title': 'im-hub-pro · status',
  'svc.status.systemd_active': 'systemd unit `im-hub.service` is active (pid {pid})',
  'svc.status.systemd_inactive': 'systemd unit `im-hub.service` exists but is inactive',
  'svc.status.bg_running': 'background daemon running (pid {pid}, log: {log})',
  'svc.status.fg_running': 'foreground process running (pid {pid})',
  'svc.status.not_running': 'no running im-hub-pro instance found',
  'svc.status.web': 'web console: http://{bind}:{port}',
  'svc.status.uptime': 'uptime: {duration}',

  'svc.start.starting_fg': 'Starting in foreground — Ctrl-C to stop.',
  'svc.start.starting_bg': 'Starting in background…',
  'svc.start.bg_ready': '✅ Background daemon started (pid {pid}, log: {log})',
  'svc.start.bg_hint': 'Tip: use `im-hub-pro stop` to terminate; `im-hub-pro status` to inspect.',
  'svc.start.systemd_managed': 'A systemd unit already manages im-hub. Use `systemctl start im-hub.service`.',
  'svc.start.already_running': 'Already running (pid {pid}). Use `im-hub-pro restart` instead.',

  'svc.stop.stopping_systemd': 'Stopping systemd unit `im-hub.service`…',
  'svc.stop.stopping_bg': 'Stopping background daemon (pid {pid})…',
  'svc.stop.not_running': 'Nothing to stop — im-hub-pro is not running.',
  'svc.stop.stopped': '✅ Stopped.',

  'svc.restart.systemd': 'Restarting via `systemctl restart im-hub.service`…',
  'svc.restart.bg': 'Restarting background daemon…',
  'svc.restart.fg_warning': 'A foreground process is running; cannot restart from another shell. Stop it (Ctrl-C) and run `im-hub-pro start --bg`.',
  'svc.restart.done': '✅ Restarted.',

  'svc.uninstall.confirm': 'Uninstall im-hub-pro? This stops the service, removes the npm install + ~/.im-hub/config.json + systemd unit. Workspaces under ~/.im-hub-workspaces/ are KEPT.',
  'svc.uninstall.stopping': 'Stopping any running instance…',
  'svc.uninstall.removing_npm': 'Removing global npm package `im-hub-pro`…',
  'svc.uninstall.removing_unit': 'Removing systemd unit…',
  'svc.uninstall.removing_config': 'Removing ~/.im-hub/config.json + env…',
  'svc.uninstall.workspaces_kept': 'Workspaces kept at ~/.im-hub-workspaces/ (your memos / sessions / agent data).',
  'svc.uninstall.done': '✅ Uninstalled. Workspaces preserved.',
  'svc.uninstall.cancelled': 'Cancelled.',

  // ─── shared ──────────────────────────────────────────────────────────
  'back': '← Back',
  'cancel': 'Cancel',
  'confirm': 'Confirm',
  'yes': 'Yes',
  'no': 'No',
  'skip': 'Skip',
  'press_enter_for_default': '(Enter = accept default)',
  'press_esc_to_skip': '(Esc = skip)',
  'error.prefix': '❌ Error: {message}',
  'warning.prefix': '⚠️  {message}',
  'info.prefix': 'ℹ {message}',
  'ok.prefix': '✓ {message}',
} as const

export type Key = keyof typeof en

// `Record<Key, string>` — TS errors if you forget to translate a key.
const zh: Record<Key, string> = {
  // ─── language picker ──────────────────────────────────────────────
  'lang.pick': '选择界面语言 / Select language',
  'lang.label.en': 'English',
  'lang.label.zh': '中文',
  'lang.saved': '语言偏好已保存到 {file}',

  // ─── entry menu ──────────────────────────────────────────────────
  'menu.title': 'im-hub-pro · 维护入口',
  'menu.subtitle': '想做什么？',
  'menu.config': '配置（IM / Agent / SMTP / 百度地图 …）',
  'menu.status': '查看服务状态',
  'menu.start': '启动服务（前台）',
  'menu.start_bg': '启动服务（后台）',
  'menu.restart': '重启服务',
  'menu.stop': '停止服务',
  'menu.uninstall': '卸载 im-hub-pro（保留 workspaces）',
  'menu.quit': '退出',

  // ─── config root ─────────────────────────────────────────────────
  'config.title': 'im-hub-pro · 配置',
  'config.subtitle': '选要编辑的分类。每个分类内部都能 Back 回上一层。',
  'config.section.messengers': 'IM 渠道（微信 / Telegram / 飞书 / Discord / 邮件）',
  'config.section.agents': 'AI Agent（Claude Code / OpenCode / Codex / Copilot）',
  'config.section.acp': '远程 ACP agent',
  'config.section.smtp': 'SMTP — /remind 邮件发送',
  'config.section.baidu': '百度地图 AK — /memo 地址解析',
  'config.section.done': '完成 — 保存并退出',
  'config.saved': '配置已保存到 {file}',

  // ─── messengers ──────────────────────────────────────────────────
  'messengers.pick': '勾选要启用的 IM（Space 切换 / Enter 确认）',
  'messengers.hint.wechat': '微信（iLink bot）— 扫码登录',
  'messengers.hint.telegram': 'Telegram — @BotFather 拿 bot token',
  'messengers.hint.feishu': '飞书 / Lark — App ID + Secret',
  'messengers.hint.discord': 'Discord — bot token（Discord 开发者后台）',
  'messengers.hint.email': '邮件（SMTP，只推送）',

  // ─── agents ──────────────────────────────────────────────────────
  'agents.pick': '勾选要启用的 agent（Space 切换 / Enter 确认）',
  'agents.default': '默认 agent（无 /prefix 时用谁）',
  'agents.hint.claude': 'Claude Code（需先装：`claude --version`）',
  'agents.hint.opencode': 'OpenCode（需先装：`opencode --version`）',
  'agents.hint.codex': 'Codex（需先装：`codex --version`）',
  'agents.hint.copilot': 'GitHub Copilot CLI',

  // ─── ACP agents ──────────────────────────────────────────────────
  'acp.title': '远程 ACP agent',
  'acp.subtitle': '走 ACP 协议的 HTTP agent。可以新增 / 编辑 / 删除。',
  'acp.action.add': '+ 新增 agent',
  'acp.action.edit': '编辑 {name}',
  'acp.action.remove': '删除 {name}',
  'acp.action.back': '← 返回',
  'acp.field.name': 'Agent 名称（用作 /prefix）',
  'acp.field.endpoint': 'Endpoint URL（例：https://api.example.com）',
  'acp.field.auth_type': '认证方式',
  'acp.field.auth_token': 'Bearer token',
  'acp.auth.none': '无（公开 endpoint）',
  'acp.auth.bearer': 'Bearer token',
  'acp.added': '已新增 agent：{name}',
  'acp.removed': '已删除 agent：{name}',

  // ─── SMTP ────────────────────────────────────────────────────────
  'smtp.title': 'SMTP（用于 /remind 邮件投递）',
  'smtp.subtitle': '凭据会写到 ~/.im-hub/env（chmod 600）。不用邮件就跳过。',
  'smtp.preset': '选一个预设或自定义',
  'smtp.preset.gmail': 'Gmail（smtp.gmail.com:465，需要应用专用密码）',
  'smtp.preset.outlook': 'Outlook（smtp.office365.com:587）',
  'smtp.preset.qq': 'QQ 邮箱（smtp.qq.com:465，需要授权码）',
  'smtp.preset.163': '163 邮箱（smtp.163.com:465，需要授权码）',
  'smtp.preset.custom': '自定义 SMTP 服务器',
  'smtp.preset.skip': '跳过 — 禁用 SMTP',
  'smtp.field.host': 'SMTP 主机',
  'smtp.field.port': 'SMTP 端口',
  'smtp.field.user': 'SMTP 登录用户（邮箱地址）',
  'smtp.field.pass': 'SMTP 密码 / 应用专用密码（输入隐藏）',
  'smtp.field.from': '发件人地址（Enter = 跟登录用户一致）',
  'smtp.field.secure': 'TLS 模式',
  'smtp.secure.auto': 'auto（推荐）',
  'smtp.secure.true': 'true（连接即 SSL，例：465 端口）',
  'smtp.secure.false': 'false（STARTTLS，例：587 端口）',
  'smtp.saved': 'SMTP 凭据已保存到 {file}（chmod 600）',
  'smtp.cleared': 'SMTP 已禁用 — 清除了 {file}',

  // ─── Baidu Maps AK ───────────────────────────────────────────────
  'baidu.title': '百度地图 AK（用于 /memo 地址解析）',
  'baidu.subtitle': '可选——没有 AK 时 /memo 仍能用直接坐标 + 浏览器 GPS。',
  'baidu.howto': '免费申请：https://lbsyun.baidu.com → 控制台 → 应用管理 → 创建应用 → 服务端 API',
  'baidu.action.set': '设置 / 更新 AK',
  'baidu.action.clear': '清除 AK（禁用 geocoding）',
  'baidu.action.back': '← 返回',
  'baidu.input': '粘贴 AK（32 字符，非数字开头；留空跳过）',
  'baidu.saved': '百度地图 AK 已保存到 {file}',
  'baidu.cleared': '百度地图 AK 已清除',

  // ─── service mgmt ────────────────────────────────────────────────
  'svc.status.title': 'im-hub-pro · 状态',
  'svc.status.systemd_active': 'systemd 单元 `im-hub.service` 正在运行（pid {pid}）',
  'svc.status.systemd_inactive': 'systemd 单元 `im-hub.service` 存在但未启动',
  'svc.status.bg_running': '后台守护进程在跑（pid {pid}，日志：{log}）',
  'svc.status.fg_running': '前台进程在跑（pid {pid}）',
  'svc.status.not_running': '未发现 im-hub-pro 实例',
  'svc.status.web': 'Web 控制台：http://{bind}:{port}',
  'svc.status.uptime': '运行时长：{duration}',

  'svc.start.starting_fg': '前台启动中——Ctrl-C 退出。',
  'svc.start.starting_bg': '后台启动中…',
  'svc.start.bg_ready': '✅ 后台守护进程已启动（pid {pid}，日志：{log}）',
  'svc.start.bg_hint': '提示：`im-hub-pro stop` 终止；`im-hub-pro status` 查看。',
  'svc.start.systemd_managed': '已有 systemd 单元管理 im-hub。用 `systemctl start im-hub.service`。',
  'svc.start.already_running': '已经在跑（pid {pid}）。用 `im-hub-pro restart` 重启。',

  'svc.stop.stopping_systemd': '停止 systemd 单元 `im-hub.service`…',
  'svc.stop.stopping_bg': '停止后台守护进程（pid {pid}）…',
  'svc.stop.not_running': '没在跑，无需停止。',
  'svc.stop.stopped': '✅ 已停止。',

  'svc.restart.systemd': '通过 `systemctl restart im-hub.service` 重启…',
  'svc.restart.bg': '重启后台守护进程…',
  'svc.restart.fg_warning': '前台进程在跑，无法从其他 shell 重启它。请在那个 shell 里 Ctrl-C 后用 `im-hub-pro start --bg`。',
  'svc.restart.done': '✅ 已重启。',

  'svc.uninstall.confirm': '确定卸载 im-hub-pro 吗？将停止服务、移除全局 npm 包 + ~/.im-hub/config.json + systemd 单元。~/.im-hub-workspaces/ 下的工作区数据 **保留**。',
  'svc.uninstall.stopping': '停止运行中的实例…',
  'svc.uninstall.removing_npm': '移除全局 npm 包 `im-hub-pro`…',
  'svc.uninstall.removing_unit': '移除 systemd 单元…',
  'svc.uninstall.removing_config': '移除 ~/.im-hub/config.json + env…',
  'svc.uninstall.workspaces_kept': '工作区数据保留在 ~/.im-hub-workspaces/（你的 memos / sessions / agent 数据）。',
  'svc.uninstall.done': '✅ 卸载完成。工作区数据已保留。',
  'svc.uninstall.cancelled': '已取消。',

  // ─── shared ──────────────────────────────────────────────────────
  'back': '← 返回',
  'cancel': '取消',
  'confirm': '确认',
  'yes': '是',
  'no': '否',
  'skip': '跳过',
  'press_enter_for_default': '（Enter 接受默认）',
  'press_esc_to_skip': '（Esc 跳过）',
  'error.prefix': '❌ 错误：{message}',
  'warning.prefix': '⚠️  {message}',
  'info.prefix': 'ℹ {message}',
  'ok.prefix': '✓ {message}',
}

const dicts: Record<Lang, Record<string, string>> = { en, zh }

/** Translate. If `key` is missing in `lang`, falls back to en, then to the key itself. */
export function t(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  let s: string = dicts[lang]?.[key] ?? en[key] ?? key
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
  }
  return s
}

/** Read persisted preference; returns null when not set. */
export function readSavedLang(): Lang | null {
  try {
    const raw = readFileSync(PREF_FILE, 'utf-8').trim()
    if (raw === 'en' || raw === 'zh') return raw
  } catch { /* not set */ }
  return null
}

/** Persist to ~/.im-hub/cli-lang. Best-effort — failures only logged. */
export function saveLang(lang: Lang): void {
  try {
    mkdirSync(dirname(PREF_FILE), { recursive: true })
    writeFileSync(PREF_FILE, lang + '\n', { mode: 0o644 })
  } catch (err) {
    console.warn(`⚠️ Could not save language preference: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const LANG_PREF_FILE = PREF_FILE
