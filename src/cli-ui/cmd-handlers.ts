// cli-ui/cmd-handlers.ts — implementations of the 5 service-management
// commands. Each handler reads the persisted language preference, prints
// status / outcomes in that language, and shells out to systemctl / npm /
// rm where appropriate.

import { execFileSync, execSync } from 'node:child_process'
import { unlinkSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  detectService,
  spawnBackground,
  stopService,
  formatUptime,
  findTcpListenOwner,
  readWebEndpoint,
  DEFAULT_WEB_PORT,
  PID_FILE,
  LOG_FILE,
} from './service.js'
import { menu, inputText, UserAbortError } from './prompts.js'
import { pickLang } from './lang-picker.js'
import { readSavedLang, resolveCliLang, t, type Lang } from './i18n.js'
import { CONFIG_DIR, CONFIG_FILE, WORKSPACES_DIR } from './paths.js'
import { ENV_FILE, readEnvFile, removeEnvFile } from './env-file.js'

function localWebUrl(web: { bind: string; port: number }): string {
  const bind = web.bind === '0.0.0.0' ? '127.0.0.1' : web.bind
  return `http://${bind}:${web.port}`
}

function webConsoleUrl(
  web: { bind: string; port: number },
  opts: { welcome?: boolean; path?: string } = {},
): string {
  const base = localWebUrl(web)
  if (opts.path) {
    const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`
    return `${base}${path}`
  }
  return opts.welcome ? `${base}/?welcome=1` : base
}

function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'xdg-open', args: [url] }
  }
  return null
}

function openBrowserUrl(url: string): boolean {
  const cmd = browserOpenCommand(url)
  if (!cmd) return false
  try {
    execFileSync(cmd.command, cmd.args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function printBrowserOpenResult(lang: Lang, ok: boolean, url: string): void {
  console.log(ok
    ? text(lang, `浏览器：已打开 ${url}`, `Browser: opened ${url}`)
    : text(lang, '浏览器：无法自动打开，请手动复制上面的地址。', 'Browser: could not open automatically; copy the URL above.'))
}

function printWebConsoleLine(
  lang: Lang,
  web: { bind: string; port: number },
  opts: { welcome?: boolean; path?: string } = {},
): void {
  console.log(text(lang, '   Web 控制台：', '   Web console:') + webConsoleUrl(web, opts))
}

function text(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function describeRecentStartupFailure(lang: Lang): string | null {
  if (!existsSync(LOG_FILE)) return null
  try {
    const raw = readFileSync(LOG_FILE, 'utf-8')
    const tail = raw.split(/\r?\n/).slice(-160).join('\n')
    const match = tail.match(/listen EADDRINUSE: address already in use\s+([^\s:]+):(\d+)/)
    if (!match) return null
    const bind = match[1]
    const port = Number.parseInt(match[2], 10)
    if (!Number.isFinite(port)) return null

    const web = readWebEndpoint() ?? { bind: '127.0.0.1', port: 3000 }
    const owner = findTcpListenOwner(port)
    const ownerText = owner
      ? text(lang, `，当前占用进程：${owner}`, `, current owner: ${owner}`)
      : ''

    if (port === web.port) {
      return text(
        lang,
        `启动失败原因：Web 端口 ${bind}:${port} 已被占用${ownerText}。\n` +
          '   请关闭占用程序，或运行 agim config 修改 Web 端口后重试。',
        `Startup failed because Web port ${bind}:${port} is already in use${ownerText}.\n` +
          '   Close the owner process, or run agim config to change the Web port and retry.',
      )
    }

    return text(
      lang,
      `启动失败原因：本地端口 ${bind}:${port} 已被占用${ownerText}。`,
      `Startup failed because local port ${bind}:${port} is already in use${ownerText}.`,
    )
  } catch { return null }
}

function printStartupCheckLog(lang: Lang): void {
  const diagnosis = describeRecentStartupFailure(lang)
  if (diagnosis) console.log(diagnosis)
  console.log(t(lang, 'svc.offer.bg_check_log'))
  if (existsSync(LOG_FILE)) {
    console.log(`   tail -n 40 ${LOG_FILE}`)
  } else {
    console.log(text(
      lang,
      `   日志文件尚未生成；任意一次成功 start（前台 / --bg / systemd）后会写入：${LOG_FILE}`,
      `   Log file has not been created yet; it appears after any successful start (foreground / --bg / systemd): ${LOG_FILE}`,
    ))
  }
}

/** Probe the public /api/health endpoint (no auth). */
async function probeLocalWebHealth(url: string): Promise<boolean> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 800)
    try {
      const res = await fetch(url, { signal: ac.signal })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/**
 * After spawnBackground, wait until the child is serving /api/health
 * (or dies). Replaces the old fixed 1.5s sleep that raced cold starts
 * and often printed the token hint before web-bootstrap-token existed.
 */
async function waitForBackgroundReady(
  pid: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<'ready' | 'dead'> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const pollMs = opts.pollMs ?? 400
  const endpoint = readWebEndpoint() ?? { bind: '127.0.0.1', port: DEFAULT_WEB_PORT }
  const host = endpoint.bind === '0.0.0.0' || endpoint.bind === '::' || endpoint.bind === '[::]'
    ? '127.0.0.1'
    : endpoint.bind
  const healthUrl = `http://${host}:${endpoint.port}/api/health`
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return 'dead'
    }
    if (await probeLocalWebHealth(healthUrl)) return 'ready'
    await new Promise((r) => setTimeout(r, pollMs))
  }

  // Process still alive after the window — treat as ready so status / token
  // hints still print (health may be slow behind a heavy optional import).
  try {
    process.kill(pid, 0)
    return 'ready'
  } catch {
    return 'dead'
  }
}

async function startBackgroundDaemon(
  lang: Lang,
  opts: { showAccessHint?: boolean; welcome?: boolean; path?: string } = {},
): Promise<boolean> {
  console.log(t(lang, 'svc.start.starting_bg'))
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const cliJs = join(__dirname, '..', 'cli.js')
  const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
  const ready = await waitForBackgroundReady(pid)
  const after = detectService()
  if (ready === 'ready' && after.mode === 'background' && after.pid === pid) {
    console.log(t(lang, 'svc.start.bg_ready', { pid, log: LOG_FILE }))
    if (opts.showAccessHint !== false) {
      console.log(t(lang, 'svc.start.bg_hint'))
      await printWebAccessHint(lang, { welcome: opts.welcome, path: opts.path })
    }
    return true
  }
  printStartupCheckLog(lang)
  return false
}

/** Candidate paths for the systemd unit. Resolved at runtime by
 *  `findSystemdUnit()` so we operate on the unit only when it exists. */
const SYSTEMD_UNIT_CANDIDATES = [
  '/etc/systemd/system/agim.service',
] as const

function findSystemdUnit(): { path: string; name: string } | null {
  for (const path of SYSTEMD_UNIT_CANDIDATES) {
    if (existsSync(path)) {
      return { path, name: path.split('/').pop() ?? '' }
    }
  }
  return null
}

/** Path of the unit file, if any exists, for compat with code that
 *  references this constant. Resolved lazily so cleanup can drop it. */
function systemdUnitPath(): string | null {
  return findSystemdUnit()?.path ?? null
}

/** Pick whichever language is already saved, falling back to 'zh'. We
 *  don't re-prompt for language inside per-command handlers — they
 *  shouldn't disrupt scripted flows. */
function quietLang(): Lang {
  return resolveCliLang()
}

// ─── status ──────────────────────────────────────────────────────────

export function cmdStatus(): void {
  const lang = quietLang()
  console.log()
  console.log(t(lang, 'svc.status.title'))
  console.log('─'.repeat(50))
  const st = detectService()
  const web = readWebEndpoint() ?? { bind: '127.0.0.1', port: DEFAULT_WEB_PORT }
  const webBind = web.bind === '0.0.0.0' ? '127.0.0.1' : web.bind
  switch (st.mode) {
    case 'systemd':
      console.log(`  ${t(lang, 'svc.status.systemd_active', { pid: st.pid ?? '?' })}`)
      break
    case 'background':
      console.log(`  ${t(lang, 'svc.status.bg_running', { pid: st.pid ?? '?', log: LOG_FILE })}`)
      break
    case 'foreground':
      console.log(`  ${t(lang, 'svc.status.fg_running', { pid: st.pid ?? '?' })}`)
      break
    case 'none':
      console.log(`  ${t(lang, 'svc.status.not_running')}`)
      if (systemdUnitPath()) {
        console.log(`  ${t(lang, 'svc.status.systemd_inactive')}`)
      }
      console.log(`  ${t(lang, 'svc.status.web', { bind: webBind, port: web.port })}`)
      console.log(`  ${t(lang, 'svc.status.next_not_running')}`)
      console.log()
      return
  }
  if (typeof st.uptimeSec === 'number') {
    console.log(`  ${t(lang, 'svc.status.uptime', { duration: formatUptime(st.uptimeSec) })}`)
  }
  console.log(`  ${t(lang, 'svc.status.web', { bind: webBind, port: web.port })}`)
  console.log(`  ${t(lang, 'svc.status.next_running')}`)
  console.log()
}

function loadWebRelatedEnv(): void {
  try {
    const f = readEnvFile()
    for (const k of [
      'AGIM_WEB_BIND',
      'AGIM_WEB_AUTH',
      'AGIM_TRUST_LOOPBACK',
      'AGIM_VIEWER_PUBLIC_BASE_URL',
      'AGIM_VIEWER_TUNNEL_MODE',
      'AGIM_VIEWER_ENABLED',
    ]) {
      if (f[k] && !process.env[k]) process.env[k] = f[k]
    }
  } catch { /* ignore */ }
}

function isEnvOff(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false' || v === 'no'
}

function describeServiceState(lang: Lang): string {
  const st = detectService()
  switch (st.mode) {
    case 'systemd':
      return st.pid
        ? text(lang, `运行中：systemd，pid ${st.pid}`, `running: systemd, pid ${st.pid}`)
        : text(lang, `systemd 已接管，状态：${st.active ?? 'unknown'}`, `managed by systemd, state: ${st.active ?? 'unknown'}`)
    case 'background':
      return text(lang, `运行中：后台进程，pid ${st.pid ?? '?'}`, `running: background daemon, pid ${st.pid ?? '?'}`)
    case 'foreground':
      return text(lang, `运行中：前台进程，pid ${st.pid ?? '?'}`, `running: foreground process, pid ${st.pid ?? '?'}`)
    case 'none':
      return text(lang, '未运行', 'not running')
  }
}

async function getPublicWebInfo(): Promise<{ url: string; source: string } | null> {
  const { getEffectivePublicBaseUrl, getViewerConfig } = await import('../core/viewer-config.js')
  const cfg = getViewerConfig()
  const url = getEffectivePublicBaseUrl()
  if (!url) return null
  return {
    url,
    source: cfg.publicBaseUrl ? 'AGIM_VIEWER_PUBLIC_BASE_URL' : 'cloudflared tunnel',
  }
}

async function printWebCredentialHint(lang: Lang): Promise<void> {
  try {
    const {
      getWebBootstrapTokenFile,
      hasAnyToken,
      isAuthEnabled,
    } = await import('../core/access-token.js')
    if (!isAuthEnabled()) {
      console.log(text(lang, '登录：Web 鉴权已关闭（AGIM_WEB_AUTH=off）。', 'Login: Web auth is disabled (AGIM_WEB_AUTH=off).'))
      return
    }
    const trustLoopback = !isEnvOff('AGIM_TRUST_LOOPBACK')
    console.log(trustLoopback
      ? text(lang, '登录：本机浏览器直连通常无需 token；远程/反代访问需要 Web token。', 'Login: local browser access usually needs no token; remote/proxied access needs a Web token.')
      : text(lang, '登录：本机 loopback 免登录已关闭，也需要 Web token。', 'Login: loopback trust is disabled; local access also needs a Web token.'))

    const bootstrapFile = getWebBootstrapTokenFile()
    if (existsSync(bootstrapFile)) {
      console.log(text(lang, '首次 token：运行 `agim token bootstrap` 读取一次性 token。', 'First token: run `agim token bootstrap` to read the one-time token.'))
      return
    }
    if (hasAnyToken()) {
      console.log(text(lang, '忘记 token：运行 `agim token create <label>` 生成一个新的。', 'Forgot the token: run `agim token create <label>` to create a new one.'))
      return
    }
    console.log(text(lang, '尚无 token：首次启动会生成；也可以运行 `agim token create <label>`。', 'No token yet: first startup will generate one; or run `agim token create <label>`.'))
  } catch {
    console.log(text(lang, 'Token 帮助：agim token bootstrap 或 agim token create <label>', 'Token help: agim token bootstrap or agim token create <label>'))
  }
}

export async function cmdWeb(opts: {
  public?: boolean
  welcome?: boolean
  open?: boolean
  start?: boolean
  openBrowser?: (url: string) => boolean
} = {}): Promise<number> {
  const lang = quietLang()
  loadWebRelatedEnv()
  const publicInfo = await getPublicWebInfo()
  const openBrowser = opts.openBrowser ?? openBrowserUrl

  if (opts.public) {
    if (publicInfo) {
      console.log(publicInfo.url)
      console.log(text(lang, `(来源：${publicInfo.source})`, `(source: ${publicInfo.source})`))
      if (opts.open) printBrowserOpenResult(lang, openBrowser(publicInfo.url), publicInfo.url)
      return 0
    }
    const tunnelMode = (process.env.AGIM_VIEWER_TUNNEL_MODE || '').toLowerCase()
    if (tunnelMode === 'quick') {
      console.log(text(
        lang,
        '公网地址由 cloudflared 临时隧道提供，但当前 CLI 进程查不到运行中隧道 URL。',
        'The public URL comes from a cloudflared quick tunnel, but this CLI process cannot see the running tunnel URL.',
      ))
      console.log(text(lang, '请在 IM 内发送 /web，或先确认 Agim daemon 正在运行。', 'Send /web in IM, or confirm the Agim daemon is running.'))
      return 2
    }
    console.log(text(lang, '公网地址未配置。需要反代域名时设置 AGIM_VIEWER_PUBLIC_BASE_URL。', 'No public URL configured. Set AGIM_VIEWER_PUBLIC_BASE_URL when using a reverse-proxy domain.'))
    return 2
  }

  const endpoint = readWebEndpoint() ?? {
    bind: (process.env.AGIM_WEB_BIND || '127.0.0.1').trim() || '127.0.0.1',
    port: DEFAULT_WEB_PORT,
  }
  const before = detectService()
  if (before.mode === 'none' && opts.start) {
    await startBackgroundDaemon(lang, { showAccessHint: false, welcome: opts.welcome })
  }
  const service = detectService()
  const url = webConsoleUrl(endpoint, { welcome: opts.welcome })
  console.log()
  console.log(text(lang, 'Agim Web 控制台', 'Agim Web console'))
  console.log('='.repeat(34))
  console.log(text(lang, '服务：', 'Service:') + describeServiceState(lang))
  console.log(text(lang, '本机地址：', 'Local URL:') + url)
  if (publicInfo) {
    console.log(`${text(lang, '远程地址：', 'Remote URL:')}${publicInfo.url} (${publicInfo.source})`)
  }
  if (service.mode === 'none') {
    console.log(text(
      lang,
      '启动：首次体验用 `agim go`；已配置好则用 `agim start --bg`。',
      'Start: use `agim go` for first run; use `agim start --bg` after setup.',
    ))
    console.log(text(
      lang,
      '一键启动并打开：agim web --start --open',
      'Start and open in one step: agim web --start --open',
    ))
  } else {
    console.log(text(lang, '下一步：打开上面的地址发送第一条消息。', 'Next: open the URL above and send the first message.'))
    if (!opts.open) {
      console.log(text(lang, '打开浏览器：agim web --open', 'Open in browser: agim web --open'))
    }
  }
  await printWebCredentialHint(lang)
  if (opts.open) {
    if (service.mode === 'none') {
      console.log(text(
        lang,
        '浏览器：服务未运行，未打开；可运行 `agim web --start --open`。',
        'Browser: service is not running; run `agim web --start --open`.',
      ))
    } else {
      printBrowserOpenResult(lang, openBrowser(url), url)
    }
  }
  return 0
}

// ─── start ───────────────────────────────────────────────────────────

/**
 * Foreground start is implemented by `program.command('start').action(...)`
 * in cli.ts; this handler delegates to it. For background, we re-spawn
 * ourselves detached.
 */
export async function cmdStart(bg: boolean, runForegroundStart: () => Promise<void>): Promise<void> {
  const lang = quietLang()
  const st = detectService()
  if (st.mode === 'systemd') {
    console.log(t(lang, 'svc.start.systemd_managed'))
    return
  }
  if (st.mode !== 'none') {
    console.log(t(lang, 'svc.start.already_running', { pid: st.pid ?? '?' }))
    return
  }
  if (bg) {
    await startBackgroundDaemon(lang)
    return
  }
  console.log(t(lang, 'svc.start.starting_fg'))
  await runForegroundStart()
}

// ─── stop ────────────────────────────────────────────────────────────

export async function cmdStop(): Promise<void> {
  const lang = quietLang()
  const st = detectService()
  if (st.mode === 'none') {
    console.log(t(lang, 'svc.stop.not_running'))
    return
  }
  if (st.mode === 'systemd') {
    console.log(t(lang, 'svc.stop.stopping_systemd'))
  } else if (st.mode === 'background') {
    console.log(t(lang, 'svc.stop.stopping_bg', { pid: st.pid ?? '?' }))
  } else if (st.mode === 'foreground') {
    console.log(`⚠️ ${lang === 'zh'
      ? '检测到前台进程在跑。会发 SIGTERM，但建议你回那个 shell 里 Ctrl-C。'
      : 'Foreground process detected. Sending SIGTERM — but Ctrl-C in the owning shell is cleaner.'}`)
  }
  await stopService()
  console.log(t(lang, 'svc.stop.stopped'))
}

// ─── restart ─────────────────────────────────────────────────────────

export async function cmdRestart(): Promise<void> {
  const lang = quietLang()
  const st = detectService()
  if (st.mode === 'systemd') {
    console.log(t(lang, 'svc.restart.systemd'))
    const unit = findSystemdUnit()
    if (unit) execSync(`systemctl restart ${unit.name}`, { stdio: 'inherit' })
    console.log(t(lang, 'svc.restart.done'))
    await printWebAccessHint(lang)
    return
  }
  if (st.mode === 'foreground') {
    console.log(t(lang, 'svc.restart.fg_warning'))
    return
  }
  if (st.mode === 'background' || st.mode === 'none') {
    console.log(t(lang, 'svc.restart.bg'))
    if (st.mode === 'background') await stopService()
    // Re-spawn detached.
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const cliJs = join(__dirname, '..', 'cli.js')
    const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
    const ready = await waitForBackgroundReady(pid)
    const after = detectService()
    if (ready === 'ready' && after.mode === 'background' && after.pid === pid) {
      console.log(t(lang, 'svc.start.bg_ready', { pid, log: LOG_FILE }))
      console.log(t(lang, 'svc.restart.done'))
      await printWebAccessHint(lang)
    } else {
      printStartupCheckLog(lang)
    }
  }
}

// ─── uninstall ───────────────────────────────────────────────────────

type UninstallMode = 'keep' | 'creds' | 'full'

/** The credential files that mode='creds' and mode='full' both wipe. */
function credentialFiles(): string[] {
  return [
    join(CONFIG_DIR, 'tokens.json'),
    join(CONFIG_DIR, 'admin-bootstrap-token'),
    join(CONFIG_DIR, 'web-bootstrap-token'),
    join(CONFIG_DIR, 'llm-secrets.json'),
    // Legacy token file from pre-Web-token-unified versions.
    join(CONFIG_DIR, 'acp-token'),
    join(CONFIG_DIR, 'approval-bus.sock'),
  ]
}

/** Cheap probe for `shred` on PATH — used to decide whether full-destruction
 *  mode can do a secure overwrite or has to fall back to plain unlink. */
function hasShred(): boolean {
  try {
    execSync('command -v shred', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Best-effort secure delete: shred -u when available, else unlink + warn.
 *  Returns whether the file no longer exists at end. */
function secureDelete(path: string, shredAvailable: boolean): void {
  if (!existsSync(path)) return
  if (shredAvailable) {
    try {
      execSync(`shred -u "${path.replace(/"/g, '\\"')}"`, { stdio: 'ignore' })
      return
    } catch {
      // Fall through to unlink.
    }
  } else {
    // Only warn once per uninstall — caller printed the warning before
    // looping; here we just unlink silently.
  }
  try { unlinkSync(path) } catch { /* ignore */ }
}

export async function cmdUninstall(): Promise<void> {
  const lang = readSavedLang() ?? await pickLang()
  // Path interpolations — match whatever AGIM_HOME / AGIM_WORKSPACES
  // resolved to so the prompts reflect the actual on-disk layout.
  const pathVars = {
    config: CONFIG_FILE,
    workspaces: WORKSPACES_DIR,
    home: CONFIG_DIR,
  }
  console.log()
  console.log(t(lang, 'svc.uninstall.intro'))
  console.log()

  // Pick uninstall mode. menu() throws UserAbortError on Ctrl-C; treat as
  // cancel (not a crash). We don't pass `back:` so BACK sentinel can't
  // come back, but TS still narrows the return type — handle it for
  // exhaustiveness.
  let mode: UninstallMode
  try {
    const picked = await menu<UninstallMode>({
      lang,
      message: t(lang, 'svc.uninstall.mode.prompt'),
      choices: [
        {
          value: 'keep',
          name: t(lang, 'svc.uninstall.mode.keep_name'),
          description: t(lang, 'svc.uninstall.mode.keep_desc', pathVars),
        },
        {
          value: 'creds',
          name: t(lang, 'svc.uninstall.mode.creds_name'),
          description: t(lang, 'svc.uninstall.mode.creds_desc'),
        },
        {
          value: 'full',
          name: t(lang, 'svc.uninstall.mode.full_name'),
          description: t(lang, 'svc.uninstall.mode.full_desc', pathVars),
        },
      ],
      default: 'keep',
    })
    if (typeof picked === 'symbol') {
      console.log(t(lang, 'svc.uninstall.cancelled'))
      return
    }
    mode = picked
  } catch (err) {
    if (err instanceof UserAbortError) {
      console.log(t(lang, 'svc.uninstall.cancelled'))
      return
    }
    throw err
  }

  // Full destruction needs a typed confirmation — the menu pick alone
  // is too easy to fat-finger when the consequences are irreversible.
  if (mode === 'full') {
    console.log()
    console.log(t(lang, 'svc.uninstall.full_warn', pathVars))
    console.log()
    let typed: string
    try {
      typed = await inputText({
        message: t(lang, 'svc.uninstall.full_confirm_prompt'),
      })
    } catch (err) {
      if (err instanceof UserAbortError) {
        console.log(t(lang, 'svc.uninstall.full_aborted'))
        return
      }
      throw err
    }
    if (typed.trim() !== 'DELETE') {
      console.log(t(lang, 'svc.uninstall.full_aborted'))
      return
    }
  }

  // ─── Steps common to all three modes ───────────────────────────────
  // 1. Stop any running instance.
  console.log(t(lang, 'svc.uninstall.stopping'))
  await stopService()
  // 2. Remove systemd unit if present (requires root).
  for (const unitPath of SYSTEMD_UNIT_CANDIDATES) {
    if (!existsSync(unitPath)) continue
    const unitName = unitPath.split('/').pop() ?? ''
    console.log(t(lang, 'svc.uninstall.removing_unit'))
    try {
      execSync(`systemctl disable ${unitName}`, { stdio: 'ignore' })
    } catch { /* ok if not enabled */ }
    try {
      unlinkSync(unitPath)
    } catch (err) {
      console.warn(`⚠️ Could not remove ${unitPath}: ${err instanceof Error ? err.message : String(err)} — try \`sudo rm ${unitPath}\` manually.`)
    }
  }
  try { execSync('systemctl daemon-reload', { stdio: 'ignore' }) } catch { /* ok */ }
  // 3. Remove config + env + pidfile (kept in mode=keep for backward compat
  //    with prior behaviour — config is regenerated on next `agim config`).
  console.log(t(lang, 'svc.uninstall.removing_config', pathVars))
  try { unlinkSync(CONFIG_FILE) } catch { /* missing is fine */ }
  removeEnvFile()
  try { unlinkSync(PID_FILE) } catch { /* missing is fine */ }
  // 4. Uninstall npm package globally.
  console.log(t(lang, 'svc.uninstall.removing_npm'))
  try {
    // Best-effort uninstall the current package. The public executable
    // remains `agim`; npm removes that bin with the package.
    execSync('npm uninstall -g agim-cli', { stdio: 'inherit' })
  } catch (err) {
    console.warn(`⚠️ npm uninstall failed: ${err instanceof Error ? err.message : String(err)} — run \`npm uninstall -g agim-cli\` manually.`)
  }

  if (mode === 'keep') {
    console.log()
    console.log(t(lang, 'svc.uninstall.workspaces_kept', pathVars))
    console.log(t(lang, 'svc.uninstall.done'))
    return
  }

  // ─── Mode='creds' or 'full': wipe credential files ─────────────────
  // These files are what would let an attacker keep using the Web
  // dashboard after the install is gone. unlink is fine here
  // because mode='full' falls through to a secure shred + rm -rf below.
  console.log(t(lang, 'svc.uninstall.removing_creds'))
  for (const f of credentialFiles()) {
    try { unlinkSync(f) } catch { /* missing is fine */ }
  }

  if (mode === 'creds') {
    console.log()
    console.log(t(lang, 'svc.uninstall.creds_done'))
    return
  }

  // ─── Mode='full': shred sensitive files, then rm -rf ───────────────
  // Why shred when we're about to `rm -rf`? On ext4 / xfs / btrfs without
  // FS-level encryption (LUKS / BitLocker), `rm` just unlinks — file
  // blocks linger on raw disk until reused. `shred -u` overwrites then
  // unlinks. This is a best-effort hardening — the right answer is
  // FS-level encryption, but for users who skipped that, shred catches
  // the obvious credential files.
  console.log(t(lang, 'svc.uninstall.shredding'))
  const shredAvailable = hasShred()
  if (!shredAvailable) {
    console.log(t(lang, 'svc.uninstall.shred_unavailable'))
  }
  // Re-target the files since credentialFiles() are now gone (unlinked
  // above). Sensitive-files-list also includes env + config that we
  // already unlinked in the common step — explicitly cover them in case
  // a future refactor changes ordering.
  const sensitive = [ENV_FILE, CONFIG_FILE, ...credentialFiles()]
  for (const f of sensitive) secureDelete(f, shredAvailable)

  console.log(t(lang, 'svc.uninstall.removing_all', pathVars))
  for (const dir of [CONFIG_DIR, WORKSPACES_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`⚠️ Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log()
  console.log(t(lang, 'svc.uninstall.full_done'))
}

// ─── post-config: offer to start the service ────────────────────────
//
// Called by runConfigWizard right after its transactional config save. Drops the "what
// next?" cliff users used to fall off after the wizard ended. Behaviour
// depends on the current service state:
//
//   - none       → ask "start in background now?" Y/N.
//   - background → ask "restart so changes take effect?" Y/N.
//   - systemd    → ask "systemctl restart?" Y/N (requires root; if it
//                  fails we just print the command).
//   - foreground → can't restart from here. Print a one-line hint that
//                  the user has to go back to the owning shell.
//
// Stays quiet on Ctrl-C (UserAbortError) so an exit doesn't dump a
// stack on top of a successful wizard run.

export async function offerServiceStart(
  lang: Lang,
  opts: { welcome?: boolean; path?: string; open?: boolean; assumeYes?: boolean } = {},
): Promise<void> {
  const { yesNo, UserAbortError } = await import('./prompts.js')
  const urlOpts = { welcome: opts.welcome, path: opts.path }
  const st = detectService()

  const printAndMaybeOpen = async (showUrl = true): Promise<void> => {
    await printWebAccessHint(lang, { showUrl, ...urlOpts })
    if (!opts.open) return
    const web = readWebEndpoint() ?? { bind: '127.0.0.1', port: DEFAULT_WEB_PORT }
    const url = webConsoleUrl(web, urlOpts)
    printBrowserOpenResult(lang, openBrowserUrl(url), url)
  }

  try {
    if (st.mode === 'none') {
      console.log()
      console.log(t(lang, 'svc.offer.not_running_title'))
      const wantStart = opts.assumeYes || await yesNo({
        message: t(lang, 'svc.offer.not_running_q'),
        default: true,
      })
      if (!wantStart) {
        console.log(t(lang, 'svc.offer.skipped'))
        return
      }
      // Re-exec self detached. Mirrors cmdStart(true, ...).
      const __dirname = dirname(fileURLToPath(import.meta.url))
      const cliJs = join(__dirname, '..', 'cli.js')
      const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
      const ready = await waitForBackgroundReady(pid)
      const after = detectService()
      if (ready === 'ready' && after.mode === 'background' && after.pid === pid) {
        console.log(t(lang, 'svc.offer.bg_started', { pid, log: LOG_FILE }))
        const web = readWebEndpoint()
        if (web) {
          printWebConsoleLine(lang, web, urlOpts)
        }
        await printAndMaybeOpen(false)
      } else {
        printStartupCheckLog(lang)
      }
      return
    }

    if (st.mode === 'foreground') {
      console.log()
      console.log(t(lang, 'svc.offer.running_title', { mode: 'foreground', pid: st.pid ?? '?' }))
      console.log(t(lang, 'svc.offer.foreground_hint'))
      await printAndMaybeOpen()
      return
    }

    if (opts.assumeYes) {
      await printAndMaybeOpen()
      return
    }

    // background OR systemd — same UX: ask whether to restart so the
    // freshly-saved config takes effect.
    console.log()
    console.log(t(lang, 'svc.offer.running_title', { mode: st.mode, pid: st.pid ?? '?' }))
    const wantRestart = await yesNo({
      message: t(lang, 'svc.offer.restart_q'),
      default: true,
    })
    if (!wantRestart) {
      console.log(t(lang, 'svc.offer.restart_skipped'))
      await printAndMaybeOpen()
      return
    }

    if (st.mode === 'systemd') {
      const unit = findSystemdUnit()
      if (unit) {
        try {
          execSync(`systemctl restart ${unit.name}`, { stdio: 'inherit' })
          console.log(t(lang, 'svc.offer.systemd_restarted'))
          await printAndMaybeOpen()
        } catch (err) {
          console.warn(`⚠️ ${err instanceof Error ? err.message : String(err)}`)
          console.log(`   sudo systemctl restart ${unit.name}`)
        }
      }
      return
    }

    // background: stop + re-spawn.
    await stopService()
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const cliJs = join(__dirname, '..', 'cli.js')
    const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
    const ready = await waitForBackgroundReady(pid)
    const after = detectService()
    if (ready === 'ready' && after.mode === 'background' && after.pid === pid) {
      console.log(t(lang, 'svc.offer.bg_started', { pid, log: LOG_FILE }))
      const web = readWebEndpoint()
      if (web) {
        printWebConsoleLine(lang, web, urlOpts)
      }
      await printAndMaybeOpen(false)
    } else {
      printStartupCheckLog(lang)
    }
  } catch (err) {
    if (err instanceof UserAbortError) {
      // User hit Ctrl-C inside the y/n prompt. Quiet exit — they're done.
      return
    }
    throw err
  }
}

export async function printWebAccessHint(
  lang: Lang,
  opts: { showUrl?: boolean; welcome?: boolean; path?: string } = {},
): Promise<void> {
  const web = readWebEndpoint() ?? { bind: '127.0.0.1', port: 3000 }
  const baseUrl = localWebUrl(web)
  console.log()
  if (opts.showUrl !== false) {
    console.log(text(lang, 'Web 控制台：', 'Web console:') + webConsoleUrl(web, {
      welcome: opts.welcome,
      path: opts.path,
    }))
  }
  try {
    const {
      isAuthEnabled,
      retrieveWebBootstrapTokenRaw,
      hasAnyToken,
    } = await import('../core/access-token.js')
    if (!isAuthEnabled()) {
      console.log(text(lang, 'Web 鉴权已关闭（AGIM_WEB_AUTH=off）。', 'Web auth is disabled (AGIM_WEB_AUTH=off).'))
      return
    }
    const row = retrieveWebBootstrapTokenRaw()
    if (row) {
      console.log(text(lang, '首次访问 token（仅显示这一次）：', 'First access token (shown once):'))
      console.log(`  ${row.raw}`)
      console.log(`${text(lang, '登录页：', 'Login page:')}${baseUrl}/login`)
      return
    }
    if (hasAnyToken()) {
      console.log(text(lang, '已有 Web token；如需新 token：agim token create <label>', 'A Web token already exists; create another with: agim token create <label>'))
    } else {
      console.log(text(
        lang,
        '本机 127.0.0.1 访问通常可免登；若需 token：agim token bootstrap',
        'Loopback (127.0.0.1) usually skips login; if you need a token: agim token bootstrap',
      ))
    }
  } catch {
    console.log(text(lang, '如需 Web token：agim token bootstrap 或 agim token create <label>', 'For a Web token: agim token bootstrap or agim token create <label>'))
  }
}

void readFileSync
void homedir
void ENV_FILE

export const _internal = {
  browserOpenCommand,
  waitForBackgroundReady,
  probeLocalWebHealth,
  credentialFiles,
}
