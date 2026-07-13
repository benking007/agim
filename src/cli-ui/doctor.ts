// cli-ui/doctor.ts — one-command local health check for first-run and
// support conversations. It stays network-light: LLM pinging remains in
// `agim diag llm` so `agim doctor` is safe to run on fragile installs.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { CONFIG_FILE, WORKSPACES_DIR } from './paths.js'
import { checkTcpListenAvailable, detectService, readAcpEndpoint, readWebEndpoint } from './service.js'
import { loadConfig } from '../core/onboarding.js'
import { hasAnyToken, getWebBootstrapTokenFile, isAuthEnabled } from '../core/access-token.js'
import { describeSecretSource } from '../core/llm/secrets.js'
import { checkAgentsFresh } from './readiness.js'
import { resolveCliLang, type Lang } from './i18n.js'

const require = createRequire(import.meta.url)

type Level = 'ok' | 'warn' | 'fail' | 'info'

interface CheckRow {
  level: Level
  title: string
  detail: string
}

const label: Record<Level, string> = {
  ok: '[ok]',
  warn: '[warn]',
  fail: '[fail]',
  info: '[info]',
}

function line(row: CheckRow): string {
  return `${label[row.level].padEnd(7)} ${row.title} — ${row.detail}`
}

function text(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function nodeAtLeastEngine(): boolean {
  const [majorRaw, minorRaw] = process.versions.node.split('.')
  const major = Number.parseInt(majorRaw ?? '', 10)
  const minor = Number.parseInt(minorRaw ?? '', 10)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  if (major > 22) return true
  if (major < 22) return false
  return minor >= 19
}

function sqliteAddonAvailable(): boolean {
  try {
    require('better-sqlite3')
    return true
  } catch {
    return false
  }
}

export async function collectDoctorRows(lang: Lang = resolveCliLang()): Promise<CheckRow[]> {
  const rows: CheckRow[] = []
  const config = await loadConfig()

  rows.push({
    level: nodeAtLeastEngine() ? 'ok' : 'fail',
    title: 'Node.js',
    detail: `v${process.versions.node} (${text(lang, '需要 >=22.19', 'requires >=22.19')})`,
  })

  rows.push({
    level: sqliteAddonAvailable() ? 'ok' : 'fail',
    title: 'SQLite',
    detail: sqliteAddonAvailable()
      ? text(lang, 'better-sqlite3 可用（outbox/jobs 依赖）', 'better-sqlite3 available (required for outbox/jobs)')
      : text(
        lang,
        'better-sqlite3 不可用；生产投递队列会失效，请用 Node 安装原生模块',
        'better-sqlite3 unavailable; production outbox will fail — install the native addon under Node',
      ),
  })

  rows.push({
    level: existsSync(CONFIG_FILE) ? 'ok' : 'warn',
    title: text(lang, '配置文件', 'Config'),
    detail: existsSync(CONFIG_FILE)
      ? CONFIG_FILE
      : text(lang, `尚未创建；运行 agim go 会生成`, 'not created yet; run agim go to generate it'),
  })

  const readiness = await checkAgentsFresh(config)
  rows.push({
    level: readiness.available.length > 0 ? 'ok' : 'fail',
    title: 'Agent',
    detail: readiness.available.length > 0
      ? text(lang, `可用：${readiness.available.join(', ')}`, `available: ${readiness.available.join(', ')}`)
      : text(lang, '没有可用 agent；运行 agim go 配置 Agim Agent 或安装 Claude Code / Codex', 'no available agent; run agim go to configure Agim Agent or install Claude Code / Codex'),
  })

  const raw = config as {
    llmBackends?: Array<{ name?: unknown; provider?: unknown; baseUrl?: unknown; model?: unknown }>
  }
  const backends = Array.isArray(raw.llmBackends) ? raw.llmBackends : []
  if (backends.length === 0) {
    rows.push({
      level: 'info',
      title: text(lang, '大模型 API', 'Model API'),
      detail: text(lang, '未配置；如果已有 Claude Code / Codex CLI，可暂时不需要', 'not configured; optional when a Claude Code / Codex CLI is available'),
    })
  } else {
    const keyed = backends.filter((b) => {
      if (!b || typeof b.name !== 'string') return false
      const provider = typeof b.provider === 'string' ? b.provider : undefined
      const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl : undefined
      return describeSecretSource(b.name, { provider, baseUrl }).source !== 'none'
    })
    rows.push({
      level: keyed.length > 0 ? 'ok' : 'warn',
      title: text(lang, '大模型 API', 'Model API'),
      detail: text(lang, `${keyed.length}/${backends.length} 个 backend 有密钥`, `${keyed.length}/${backends.length} backend(s) have keys`),
    })
  }

  rows.push({
    level: (config.messengers?.length ?? 0) > 0 ? 'ok' : 'info',
    title: 'IM',
    detail: (config.messengers?.length ?? 0) > 0
      ? text(lang, `已配置：${config.messengers.join(', ')}`, `configured: ${config.messengers.join(', ')}`)
      : text(lang, '未配置；Web-only 首次体验是支持的', 'not configured; web-only first use is supported'),
  })

  const st = detectService()
  rows.push({
    level: st.mode === 'none' ? 'warn' : 'ok',
    title: text(lang, '服务', 'Service'),
    detail: st.mode === 'none'
      ? text(lang, '未运行；可用 agim start --bg 启动', 'not running; start with agim start --bg')
      : `${st.mode}${st.pid ? ` pid=${st.pid}` : ''}${st.active ? ` active=${st.active}` : ''}`,
  })

  const web = readWebEndpoint()
  rows.push({
    level: web ? 'ok' : 'warn',
    title: 'Web',
    detail: web
      ? `http://${web.bind === '0.0.0.0' ? '127.0.0.1' : web.bind}:${web.port}`
      : text(lang, '未找到 Web 端口配置，默认启动会使用 3000', 'no web port config found; startup defaults to 3000'),
  })

  const acp = readAcpEndpoint()
  if (st.mode === 'none') {
    const acpCheck = await checkTcpListenAvailable(acp)
    rows.push({
      level: acpCheck.available ? 'ok' : 'warn',
      title: 'ACP',
      detail: acpCheck.available
        ? `http://${acp.bind}:${acp.port}`
        : text(
          lang,
          `端口 ${acp.bind}:${acp.port} 被占用${acpCheck.owner ? `（${acpCheck.owner}）` : ''}；Web-only 首次体验可继续，ACP 将不可用`,
          `port ${acp.bind}:${acp.port} is occupied${acpCheck.owner ? ` (${acpCheck.owner})` : ''}; web-only first use can continue, ACP will be unavailable`,
        ),
    })
  } else {
    rows.push({
      level: 'info',
      title: 'ACP',
      detail: text(lang, `随服务运行；配置端口 ${acp.bind}:${acp.port}`, `runs with the service; configured port ${acp.bind}:${acp.port}`),
    })
  }

  const bootstrapFile = getWebBootstrapTokenFile()
  if (!isAuthEnabled()) {
    rows.push({ level: 'warn', title: 'Web token', detail: 'AGIM_WEB_AUTH=off' })
  } else if (hasAnyToken()) {
    rows.push({ level: 'ok', title: 'Web token', detail: text(lang, '已存在访问 token', 'access token exists') })
  } else if (existsSync(bootstrapFile)) {
    rows.push({ level: 'warn', title: 'Web token', detail: text(lang, `bootstrap token 待读取：${bootstrapFile}`, `bootstrap token waiting at ${bootstrapFile}`) })
  } else {
    rows.push({ level: 'warn', title: 'Web token', detail: text(lang, '尚未生成；首次启动 Web 后会生成', 'not generated yet; first web start will create one') })
  }

  rows.push({
    level: existsSync(WORKSPACES_DIR) ? 'ok' : 'info',
    title: text(lang, '工作区', 'Workspaces'),
    detail: existsSync(WORKSPACES_DIR)
      ? WORKSPACES_DIR
      : text(lang, `尚未创建；首次启动时自动生成`, 'not created yet; generated on first start'),
  })

  return rows
}

export async function runDoctor(): Promise<number> {
  const lang = resolveCliLang()
  const rows = await collectDoctorRows(lang)
  console.log()
  console.log(text(lang, 'Agim 本机体检', 'Agim local doctor'))
  console.log('='.repeat(34))
  for (const row of rows) console.log(line(row))
  console.log()
  console.log(text(
    lang,
    '提示：需要真实请求大模型时，继续运行 agim diag llm。',
    'Tip: run agim diag llm when you want a real model API ping.',
  ))
  console.log(text(
    lang,
    '入口：agim web 查看控制台地址；首次配置/启动用 agim go。',
    'Entry: agim web shows the console URL; use agim go for first setup/start.',
  ))
  return rows.some((r) => r.level === 'fail') ? 1 : 0
}

export const _internal = { line }
