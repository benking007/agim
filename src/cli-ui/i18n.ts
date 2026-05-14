// cli-ui/i18n.ts — string dictionaries + persistent language preference
// for the interactive CLI wizard (agim / agim config / status / etc.).
//
// Pattern mirrors imhub-site's strings.ts: the EN dict drives the Key type,
// the ZH dict is `Record<Key, string>` so missing keys are a compile error.
//
// Language preference is persisted to ~/.agim/cli-lang (single-line file
// containing "en" or "zh"). First-run users get a language picker; later
// runs default to the saved choice (Enter accepts).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from '../core/agim-paths.js'

export type Lang = 'en' | 'zh'

const PREF_FILE = join(AGIM_HOME, 'cli-lang')

const en = {
  // ─── language picker ─────────────────────────────────────────────────
  'lang.pick': 'Select language / 选择界面语言',
  'lang.label.en': 'English',
  'lang.label.zh': '中文',
  'lang.saved': 'Language preference saved to {file}',

  // ─── entry menu (bare `agim`) ────────────────────────────────────────
  'menu.title': 'Agim · maintenance entry',
  'menu.subtitle': 'What would you like to do?',
  'menu.config': 'Configure (messengers, agents, SMTP, Baidu Maps …)',
  'menu.status': 'Show service status',
  'menu.start': 'Start the service (foreground)',
  'menu.start_bg': 'Start the service (background)',
  'menu.restart': 'Restart the service',
  'menu.stop': 'Stop the service',
  'menu.uninstall': 'Uninstall Agim (keeps workspaces)',
  'menu.quit': 'Quit',

  // ─── config root ─────────────────────────────────────────────────────
  'config.title': 'Agim · config',
  'config.subtitle': 'Pick a section to edit. Each section has a Back option.',
  'config.section.messengers': 'Messengers (WeChat / Telegram / Feishu / Discord / Email)',
  'config.section.agents': 'AI agents (Claude Code / OpenCode / Codex / Copilot)',
  'config.section.acp': 'Remote ACP agents',
  'config.section.smtp': 'SMTP — email reminder delivery',
  'config.section.baidu': 'Baidu Maps AK — /memo address geocoding',
  'config.section.done': 'Done — save and exit',
  'config.saved': 'Config saved to {file}',

  // ─── post-save service-start prompt ─────────────────────────────
  'svc.offer.not_running_title': '🚀 Service is not running yet.',
  'svc.offer.not_running_q': 'Start Agim in the background now?',
  'svc.offer.bg_started': '✅ Agim started in the background (pid {pid}, log: {log})',
  'svc.offer.bg_url': '   Web console: http://{bind}:{port}',
  'svc.offer.skipped': 'Skipped. Run `agim start` (foreground) or `agim start --bg` (background) when you are ready.',
  'svc.offer.bg_check_log': '⚠️ The background daemon may have failed — check the log:',
  'svc.offer.running_title': '✓ Agim is already running ({mode}, pid {pid}).',
  'svc.offer.restart_q': 'You changed the config — restart now so it takes effect?',
  'svc.offer.restart_skipped': 'Skipped. Run `agim restart` later when ready.',
  'svc.offer.foreground_hint': 'A foreground `agim start` is running elsewhere — restart it manually (Ctrl-C + re-run) for the new config to take effect.',
  'svc.offer.systemd_restarted': '✅ systemd restart issued.',

  // ─── messengers ──────────────────────────────────────────────────────
  'messengers.title': 'Messengers',
  'messengers.subtitle': 'Pick a messenger to configure. Each is independent.',
  'messengers.status.enabled': 'enabled',
  'messengers.status.enabled_no_creds': 'enabled (credentials missing)',
  'messengers.status.disabled': 'not configured',
  'messengers.label.wechat': 'WeChat (iLink bot)',
  'messengers.label.telegram': 'Telegram',
  'messengers.label.feishu': 'Feishu / Lark',
  'messengers.label.dingtalk': 'DingTalk (钉钉)',
  'messengers.label.discord': 'Discord',
  'messengers.label.email': 'Email (SMTP push)',
  'messengers.row': '{label} — {status}',
  'messengers.action.configure': 'Configure',
  'messengers.action.reconfigure': 'Re-configure (replace credentials)',
  'messengers.action.remove': 'Remove from enabled list',
  'messengers.action.enable_email': 'Enable email push (also requires SMTP)',
  'messengers.action.disable_email': 'Disable email push',
  'messengers.action.back': '← Back',
  'messengers.removed': '{label} removed from the enabled list.',
  'messengers.enabled': '{label} configured and enabled.',
  'messengers.smtp_hint': 'Email push relies on the SMTP settings above. Configure SMTP first if you have not.',

  // WeChat QR flow
  'wechat.fetching': 'Fetching QR code from iLink…',
  'wechat.scan': '📱 Scan with WeChat — paste the URL into a browser to render the image:',
  'wechat.waiting': 'Waiting for scan + confirm (up to 2 minutes)…',
  'wechat.logged_in': '✅ Logged in as {user} (bot id: {bot})',
  'wechat.failed': '❌ Login failed or timed out. You can retry from this menu.',

  // Telegram / Feishu / Discord help blocks
  'tg.docs': 'To get a bot token:\n  1. Open Telegram and search for @BotFather\n  2. Send /newbot and follow the prompts\n  3. Copy the bot token',
  'tg.field.token': 'Bot token',
  'tg.field.token_keep': 'Bot token (Enter = keep existing {hint})',
  'tg.field.channel': 'Channel id (optional, Enter = default)',

  'feishu.docs': 'To create a Feishu bot:\n  1. https://open.feishu.cn/app → 创建自建应用\n  2. Enable Bot capability\n  3. Subscribe to im.message.receive_v1\n  4. Permissions: im:message, im:message.p2p_msg:readonly, im:message:send_as_bot\n  5. Create + publish a version\n  6. Copy App ID and App Secret',
  'feishu.field.app_id': 'App ID',
  'feishu.field.app_secret': 'App Secret',
  'feishu.field.app_secret_keep': 'App Secret (Enter = keep existing)',

  'dingtalk.docs': 'To create a DingTalk Stream-mode bot:\n  1. https://open.dingtalk.com → create an Enterprise Internal App (1-person company works for personal use)\n  2. App → Add capability → Bot → choose Stream mode → publish\n  3. Copy ClientID (== AppKey) and ClientSecret from the app credentials page',
  'dingtalk.field.client_id': 'ClientID (AppKey)',
  'dingtalk.field.client_secret': 'ClientSecret',
  'dingtalk.field.client_secret_keep': 'ClientSecret (Enter = keep existing)',

  'discord.docs': 'To create a Discord bot:\n  1. https://discord.com/developers/applications → New Application\n  2. Bot tab → Add Bot → enable MESSAGE CONTENT INTENT (privileged)\n  3. Reset Token to grab the bot token\n  4. OAuth2 → URL Generator → invite to your server',
  'discord.field.token': 'Bot token',
  'discord.field.token_keep': 'Bot token (Enter = keep existing)',
  'discord.field.channel': 'Channel id (optional, Enter = default)',
  'discord.field.guilds': 'Allowed guild ids (comma-separated, optional)',
  'discord.field.channels': 'Allowed channel ids (comma-separated, optional)',

  // ─── agents ──────────────────────────────────────────────────────────
  'agents.title': 'AI agents',
  'agents.subtitle': 'Pick an agent to configure. Status comes from probing its CLI.',
  'agents.status.enabled_installed': 'enabled · CLI installed',
  'agents.status.enabled_missing': 'enabled · CLI NOT installed',
  'agents.status.disabled_installed': 'not enabled · CLI installed',
  'agents.status.disabled_missing': 'not enabled · CLI NOT installed',
  'agents.row': '{label} — {status}',
  'agents.label.claude-code': 'Claude Code',
  'agents.label.opencode': 'OpenCode',
  'agents.label.codex': 'Codex',
  'agents.label.copilot': 'GitHub Copilot CLI',
  'agents.action.enable': 'Add to enabled list',
  'agents.action.disable': 'Remove from enabled list',
  'agents.action.set_default': 'Set as default agent',
  'agents.action.recheck': 'Re-check CLI installation',
  'agents.action.install_hint': 'Show install instructions',
  'agents.action.back': '← Back',
  'agents.installed_msg': '✅ {label}: CLI installed and reachable.',
  'agents.missing_msg': '❌ {label}: CLI not found on PATH.',
  'agents.auth_hint.opencode': 'After install, run: opencode auth login',
  'agents.auth_hint.codex': 'After install, run: codex login',
  'agents.install_hint.claude-code': 'Install: npm install -g @anthropic-ai/claude-code',
  'agents.install_hint.opencode': 'Install: npm i -g opencode-ai@latest  (or visit https://github.com/anomalyco/opencode)',
  'agents.install_hint.codex': 'Install: npm install -g @openai/codex',
  'agents.install_hint.copilot': 'Install (any one):\n  npm i -g @github/copilot\n  gh extension install github/gh-copilot\n  brew install copilot-cli  (macOS)\n  winget install GitHub.Copilot  (Windows)\nDetails: https://github.com/features/copilot/cli',
  'agents.enabled': 'Enabled {label}{also_default}.',
  'agents.also_default': ' (also set as default)',
  'agents.removed': 'Removed {label} from enabled list.',
  'agents.default_set': 'Default agent is now {label}.',
  'agents.default_picker': 'Default agent (used when no /prefix)',
  'agents.set_default_subtitle': 'Pick the default agent.',
  'agents.set_default_action': 'Set / change default agent',

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
  'smtp.subtitle': 'These end up in {envFile} (chmod 600). Skip if email is not used.',
  'smtp.current_set': 'Currently configured: {user} via {host}:{port}',
  'smtp.current_unset': 'Currently configured: (none)',
  'smtp.action.edit': 'Edit / re-configure SMTP',
  'smtp.action.disable': 'Disable SMTP (clear all keys)',
  'smtp.action.back': '← Back',
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
  'smtp.field.pass_keep': 'SMTP password (hidden, Enter = keep existing)',
  'smtp.field.from': 'From address (Enter = same as user)',
  'smtp.field.secure': 'TLS mode',
  'smtp.secure.auto': 'auto (recommended)',
  'smtp.secure.true': 'true (SSL on connect, e.g. port 465)',
  'smtp.secure.false': 'false (STARTTLS, e.g. port 587)',
  'smtp.saved': 'SMTP credentials saved to {file} (chmod 600)',
  'smtp.cleared': 'SMTP disabled — cleared {file}',
  'env.shadowed_warn': '⚠️  {key} is also set by the running environment (systemd unit / shell export). Saving to {file} alone will NOT change the active value — update the unit file or `unset` the shell export first.',

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
  'svc.status.title': 'Agim · status',
  'svc.status.systemd_active': 'systemd unit `{unit}` is active (pid {pid})',
  'svc.status.systemd_inactive': 'systemd unit `{unit}` exists but is inactive',
  'svc.status.bg_running': 'background daemon running (pid {pid}, log: {log})',
  'svc.status.fg_running': 'foreground process running (pid {pid})',
  'svc.status.not_running': 'no running Agim instance found',
  'svc.status.web': 'web console: http://{bind}:{port}',
  'svc.status.uptime': 'uptime: {duration}',

  'svc.start.starting_fg': 'Starting in foreground — Ctrl-C to stop.',
  'svc.start.starting_bg': 'Starting in background…',
  'svc.start.bg_ready': '✅ Background daemon started (pid {pid}, log: {log})',
  'svc.start.bg_hint': 'Tip: use `agim stop` to terminate; `agim status` to inspect.',
  'svc.start.systemd_managed': 'A systemd unit already manages Agim. Use `systemctl start {unit}`.',
  'svc.start.already_running': 'Already running (pid {pid}). Use `agim restart` instead.',

  'svc.stop.stopping_systemd': 'Stopping systemd unit `{unit}`…',
  'svc.stop.stopping_bg': 'Stopping background daemon (pid {pid})…',
  'svc.stop.not_running': 'Nothing to stop — Agim is not running.',
  'svc.stop.stopped': '✅ Stopped.',

  'svc.restart.systemd': 'Restarting via `systemctl restart im-hub.service`…',
  'svc.restart.bg': 'Restarting background daemon…',
  'svc.restart.fg_warning': 'A foreground process is running; cannot restart from another shell. Stop it (Ctrl-C) and run `agim start --bg`.',
  'svc.restart.done': '✅ Restarted.',

  'svc.uninstall.confirm': 'Uninstall Agim? This stops the service, removes the npm install + {config} + systemd unit. Workspaces under {workspaces} are KEPT.',
  'svc.uninstall.stopping': 'Stopping any running instance…',
  'svc.uninstall.removing_npm': 'Removing global npm package `agim-cli`…',
  'svc.uninstall.removing_unit': 'Removing systemd unit…',
  'svc.uninstall.removing_config': 'Removing {config} + env…',
  'svc.uninstall.workspaces_kept': 'Workspaces kept at {workspaces} (your memos / sessions / agent data).',
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
  'menu.title': '阿吉姆 (Agim) · 维护入口',
  'menu.subtitle': '想做什么？',
  'menu.config': '配置（IM / Agent / SMTP / 百度地图 …）',
  'menu.status': '查看服务状态',
  'menu.start': '启动服务（前台）',
  'menu.start_bg': '启动服务（后台）',
  'menu.restart': '重启服务',
  'menu.stop': '停止服务',
  'menu.uninstall': '卸载阿吉姆（保留 workspaces）',
  'menu.quit': '退出',

  // ─── config root ─────────────────────────────────────────────────
  'config.title': '阿吉姆 · 配置',
  'config.subtitle': '选要编辑的分类。每个分类内部都能 Back 回上一层。',
  'config.section.messengers': 'IM 渠道（微信 / Telegram / 飞书 / Discord / 邮件）',
  'config.section.agents': 'AI Agent（Claude Code / OpenCode / Codex / Copilot）',
  'config.section.acp': '远程 ACP agent',
  'config.section.smtp': 'SMTP — /remind 邮件发送',
  'config.section.baidu': '百度地图 AK — /memo 地址解析',
  'config.section.done': '完成 — 保存并退出',
  'config.saved': '配置已保存到 {file}',

  // ─── 配置保存后的"是否启动服务"提示 ─────────────────────────────
  'svc.offer.not_running_title': '🚀 服务尚未启动。',
  'svc.offer.not_running_q': '现在后台启动 Agim？',
  'svc.offer.bg_started': '✅ 已后台启动 Agim（pid {pid}，日志：{log}）',
  'svc.offer.bg_url': '   Web 控制台：http://{bind}:{port}',
  'svc.offer.skipped': '已跳过。准备好后用 `agim start`（前台）或 `agim start --bg`（后台）启动。',
  'svc.offer.bg_check_log': '⚠️ 后台守护进程可能启动失败 — 看日志：',
  'svc.offer.running_title': '✓ Agim 正在运行（{mode}，pid {pid}）。',
  'svc.offer.restart_q': '配置改过了——现在重启让改动生效？',
  'svc.offer.restart_skipped': '已跳过。准备好后用 `agim restart` 重启。',
  'svc.offer.foreground_hint': '另一个 shell 在前台跑 `agim start`——回那个终端 Ctrl-C 再重新启动以让新配置生效。',
  'svc.offer.systemd_restarted': '✅ 已发送 systemd 重启指令。',

  // ─── messengers ──────────────────────────────────────────────────
  'messengers.title': 'IM 渠道',
  'messengers.subtitle': '选一个 IM 进入配置。每个 IM 独立配置。',
  'messengers.status.enabled': '已启用',
  'messengers.status.enabled_no_creds': '已启用（缺凭据）',
  'messengers.status.disabled': '未配置',
  'messengers.label.wechat': '微信（iLink bot）',
  'messengers.label.telegram': 'Telegram',
  'messengers.label.feishu': '飞书 / Lark',
  'messengers.label.dingtalk': '钉钉（DingTalk）',
  'messengers.label.discord': 'Discord',
  'messengers.label.email': '邮件（SMTP 推送）',
  'messengers.row': '{label} — {status}',
  'messengers.action.configure': '配置',
  'messengers.action.reconfigure': '重新配置（替换凭据）',
  'messengers.action.remove': '从已启用列表移除',
  'messengers.action.enable_email': '启用邮件推送（还需配 SMTP）',
  'messengers.action.disable_email': '禁用邮件推送',
  'messengers.action.back': '← 返回',
  'messengers.removed': '{label} 已从已启用列表移除。',
  'messengers.enabled': '{label} 已配置并启用。',
  'messengers.smtp_hint': '邮件推送依赖上面的 SMTP 配置，请先在 SMTP 分类里配置。',

  // 微信扫码流
  'wechat.fetching': '正在从 iLink 拉取二维码…',
  'wechat.scan': '📱 用微信扫码 —— 把下面的 URL 粘到浏览器里可以渲染成图片：',
  'wechat.waiting': '等待扫码 + 确认（最多 2 分钟）…',
  'wechat.logged_in': '✅ 已登录：{user}（bot id：{bot}）',
  'wechat.failed': '❌ 登录失败或超时，可从菜单重试。',

  // Telegram / 飞书 / Discord 帮助
  'tg.docs': '获取 bot token：\n  1. 在 Telegram 中搜 @BotFather\n  2. 发 /newbot 按提示走\n  3. 复制 bot token',
  'tg.field.token': 'Bot token',
  'tg.field.token_keep': 'Bot token（Enter = 保留现有 {hint}）',
  'tg.field.channel': 'Channel id（可选，Enter = default）',

  'feishu.docs': '创建飞书机器人：\n  1. https://open.feishu.cn/app → 创建自建应用\n  2. 启用机器人能力\n  3. 订阅事件 im.message.receive_v1\n  4. 权限：im:message、im:message.p2p_msg:readonly、im:message:send_as_bot\n  5. 创建并发布版本\n  6. 复制 App ID 与 App Secret',
  'feishu.field.app_id': 'App ID',
  'feishu.field.app_secret': 'App Secret',
  'feishu.field.app_secret_keep': 'App Secret（Enter = 保留现有）',

  'dingtalk.docs': '创建钉钉 Stream 模式机器人：\n  1. https://open.dingtalk.com → 创建"企业内部应用"（1 人企业也可以，个人自用足够）\n  2. 应用 → 添加能力 → 机器人 → 选 Stream 模式 → 发布\n  3. 在应用凭证页拿到 ClientID（即 AppKey）和 ClientSecret',
  'dingtalk.field.client_id': 'ClientID（AppKey）',
  'dingtalk.field.client_secret': 'ClientSecret',
  'dingtalk.field.client_secret_keep': 'ClientSecret（Enter = 保留现有）',

  'discord.docs': '创建 Discord 机器人：\n  1. https://discord.com/developers/applications → New Application\n  2. Bot 选项卡 → Add Bot → 开启 MESSAGE CONTENT INTENT（特权 intent）\n  3. Reset Token 获取 bot token\n  4. OAuth2 → URL Generator → 邀请到你的服务器',
  'discord.field.token': 'Bot token',
  'discord.field.token_keep': 'Bot token（Enter = 保留现有）',
  'discord.field.channel': 'Channel id（可选，Enter = default）',
  'discord.field.guilds': '允许的 guild id（英文逗号分隔，可选）',
  'discord.field.channels': '允许的 channel id（英文逗号分隔，可选）',

  // ─── agents ──────────────────────────────────────────────────────
  'agents.title': 'AI agent',
  'agents.subtitle': '选一个 agent 进入配置。状态来自实时探测 CLI。',
  'agents.status.enabled_installed': '已启用 · CLI 已安装',
  'agents.status.enabled_missing': '已启用 · CLI 未安装',
  'agents.status.disabled_installed': '未启用 · CLI 已安装',
  'agents.status.disabled_missing': '未启用 · CLI 未安装',
  'agents.row': '{label} — {status}',
  'agents.label.claude-code': 'Claude Code',
  'agents.label.opencode': 'OpenCode',
  'agents.label.codex': 'Codex',
  'agents.label.copilot': 'GitHub Copilot CLI',
  'agents.action.enable': '加入已启用列表',
  'agents.action.disable': '从已启用列表移除',
  'agents.action.set_default': '设为默认 agent',
  'agents.action.recheck': '重新检测 CLI 安装',
  'agents.action.install_hint': '查看安装说明',
  'agents.action.back': '← 返回',
  'agents.installed_msg': '✅ {label}：CLI 已安装且可调用。',
  'agents.missing_msg': '❌ {label}：PATH 中找不到 CLI。',
  'agents.auth_hint.opencode': '安装完后跑：opencode auth login',
  'agents.auth_hint.codex': '安装完后跑：codex login',
  'agents.install_hint.claude-code': '安装：npm install -g @anthropic-ai/claude-code',
  'agents.install_hint.opencode': '安装：npm i -g opencode-ai@latest（或访问 https://github.com/anomalyco/opencode）',
  'agents.install_hint.codex': '安装：npm install -g @openai/codex',
  'agents.install_hint.copilot': '安装（任选其一）：\n  npm i -g @github/copilot\n  gh extension install github/gh-copilot\n  brew install copilot-cli   （macOS）\n  winget install GitHub.Copilot  （Windows）\n详情：https://github.com/features/copilot/cli',
  'agents.enabled': '已启用 {label}{also_default}。',
  'agents.also_default': '（同时设为默认）',
  'agents.removed': '已从已启用列表移除 {label}。',
  'agents.default_set': '默认 agent 已切换为 {label}。',
  'agents.default_picker': '默认 agent（无 /prefix 时用谁）',
  'agents.set_default_subtitle': '选择默认 agent。',
  'agents.set_default_action': '设置 / 修改默认 agent',

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
  'smtp.subtitle': '凭据会写到 {envFile}（chmod 600）。不用邮件就跳过。',
  'smtp.current_set': '当前已配置：{user} via {host}:{port}',
  'smtp.current_unset': '当前已配置：（无）',
  'smtp.action.edit': '编辑 / 重新配置 SMTP',
  'smtp.action.disable': '禁用 SMTP（清除所有凭据）',
  'smtp.action.back': '← 返回',
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
  'smtp.field.pass_keep': 'SMTP 密码（隐藏，Enter = 保留现有）',
  'smtp.field.from': '发件人地址（Enter = 跟登录用户一致）',
  'smtp.field.secure': 'TLS 模式',
  'smtp.secure.auto': 'auto（推荐）',
  'smtp.secure.true': 'true（连接即 SSL，例：465 端口）',
  'smtp.secure.false': 'false（STARTTLS，例：587 端口）',
  'smtp.saved': 'SMTP 凭据已保存到 {file}（chmod 600）',
  'smtp.cleared': 'SMTP 已禁用 — 清除了 {file}',
  'env.shadowed_warn': '⚠️  {key} 同时被运行时环境（systemd 单元或 shell export）设置了。仅写 {file} **不会**改变运行时生效的值——先去改 systemd 单元，或 unset 掉 shell 里的导出。',

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
  'svc.status.title': '阿吉姆 · 状态',
  'svc.status.systemd_active': 'systemd 单元 `im-hub.service` 正在运行（pid {pid}）',
  'svc.status.systemd_inactive': 'systemd 单元 `im-hub.service` 存在但未启动',
  'svc.status.bg_running': '后台守护进程在跑（pid {pid}，日志：{log}）',
  'svc.status.fg_running': '前台进程在跑（pid {pid}）',
  'svc.status.not_running': '未发现阿吉姆实例',
  'svc.status.web': 'Web 控制台：http://{bind}:{port}',
  'svc.status.uptime': '运行时长：{duration}',

  'svc.start.starting_fg': '前台启动中——Ctrl-C 退出。',
  'svc.start.starting_bg': '后台启动中…',
  'svc.start.bg_ready': '✅ 后台守护进程已启动（pid {pid}，日志：{log}）',
  'svc.start.bg_hint': '提示：`agim stop` 终止；`agim status` 查看。',
  'svc.start.systemd_managed': '已有 systemd 单元管理 im-hub。用 `systemctl start im-hub.service`。',
  'svc.start.already_running': '已经在跑（pid {pid}）。用 `agim restart` 重启。',

  'svc.stop.stopping_systemd': '停止 systemd 单元 `im-hub.service`…',
  'svc.stop.stopping_bg': '停止后台守护进程（pid {pid}）…',
  'svc.stop.not_running': '没在跑，无需停止。',
  'svc.stop.stopped': '✅ 已停止。',

  'svc.restart.systemd': '通过 `systemctl restart im-hub.service` 重启…',
  'svc.restart.bg': '重启后台守护进程…',
  'svc.restart.fg_warning': '前台进程在跑，无法从其他 shell 重启它。请在那个 shell 里 Ctrl-C 后用 `agim start --bg`。',
  'svc.restart.done': '✅ 已重启。',

  'svc.uninstall.confirm': '确定卸载阿吉姆吗？将停止服务、移除全局 npm 包 + {config} + systemd 单元。{workspaces} 下的工作区数据 **保留**。',
  'svc.uninstall.stopping': '停止运行中的实例…',
  'svc.uninstall.removing_npm': '移除全局 npm 包 `agim-cli`…',
  'svc.uninstall.removing_unit': '移除 systemd 单元…',
  'svc.uninstall.removing_config': '移除 {config} + env…',
  'svc.uninstall.workspaces_kept': '工作区数据保留在 {workspaces}（你的 memos / sessions / agent 数据）。',
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

/** Persist to ~/.agim/cli-lang. Best-effort — failures only logged. */
export function saveLang(lang: Lang): void {
  try {
    mkdirSync(dirname(PREF_FILE), { recursive: true })
    writeFileSync(PREF_FILE, lang + '\n', { mode: 0o644 })
  } catch (err) {
    console.warn(`⚠️ Could not save language preference: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const LANG_PREF_FILE = PREF_FILE
