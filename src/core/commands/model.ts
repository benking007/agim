// /model [name|#N] + /models [filter|refresh] — model switching & listing
//
// Originally opencode-only. v1.2.50 generalised the dispatch into a
// per-agent `ModelDriver`, so the command works for any CLI that
// (a) lists models via its own CLI subcommand, (b) honours a per-call
// `--model <id>` flag, and (c) lets agim persist the picked model on
// the session row for the next turn.
//
// Drivers shipped today: opencode, cursor. To add a third, fill in
// `listModels()` + `resolveDefault()` and register in MODEL_DRIVERS.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../router.js'
import { sessionManager } from '../session.js'

/** Resolve cursor-agent the same way the adapter does so systemd's
 *  stripped PATH doesn't break `/models` while the adapter still works. */
let cachedCursorBin: string | null | undefined = null
function resolveCursorBin(): string {
  const override = process.env.AGIM_CURSOR_BIN
  if (override) return override
  if (cachedCursorBin !== null) return cachedCursorBin ?? 'cursor-agent'
  const candidates = [
    join(homedir(), '.local', 'bin', 'cursor-agent'),
    '/usr/local/bin/cursor-agent',
    '/opt/cursor/bin/cursor-agent',
  ]
  for (const p of candidates) {
    try {
      const s = statSync(p)
      if (s.isFile() && (s.mode & 0o111) !== 0) {
        cachedCursorBin = p
        return p
      }
    } catch { /* not here */ }
    if (!existsSync(p)) continue
  }
  cachedCursorBin = undefined
  return 'cursor-agent'
}

const MODEL_LIST_TTL_MS = 5 * 60 * 1000  // 5 minutes — picks up newly-added models

function sessionKey(ctx: RouteContext): string {
  return `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`
}

function parseModelArgs(args: string): { sub: string; rest: string } {
  const p = args.trim().split(/\s+/)
  return { sub: p[0] || '', rest: p.slice(1).join(' ') }
}

interface ListCache<T> { value: T; ts: number }

interface ModelDriver {
  /** Human-readable name surfaced in error / hint messages. */
  label: string
  /** Whether model ids in this driver use `provider/model` namespacing
   *  (opencode) or are flat (cursor). Affects the "short name" hint
   *  on /model switch. */
  namespaced: boolean
  /** List all available models. Cached per-agent for MODEL_LIST_TTL_MS. */
  listModels(): Promise<string[]>
  /** Resolve the agent's current default model (read from its own
   *  config file, or fall back to the first listModels entry). */
  resolveDefault(): Promise<string>
  /** Short example for the "format hint" message ("e.g. provider/model"). */
  switchHint: string
}

// ─── opencode driver (legacy default) ────────────────────────────────

const opencodeDriver: ModelDriver = {
  label: 'opencode',
  namespaced: true,
  switchHint: '例: /model deepseek/deepseek-v4-pro',

  listModels: () => new Promise((resolve) => {
    const proc = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout?.on('data', d => out += d.toString())
    proc.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean)
      resolve(lines)
    })
    proc.on('error', () => resolve([]))
  }),

  async resolveDefault(): Promise<string> {
    try {
      const { readFile } = await import('node:fs/promises')
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const configPath = join(homedir(), '.config', 'opencode', 'opencode.json')
      const raw = await readFile(configPath, 'utf-8')
      const config = JSON.parse(raw) as Record<string, unknown>
      const provider = config.provider as Record<string, { models?: Record<string, unknown> }> | undefined
      if (provider) {
        for (const [, p] of Object.entries(provider)) {
          if (p.models && typeof p.models === 'object') {
            const keys = Object.keys(p.models)
            if (keys.length > 0) return keys[0]
          }
        }
      }
    } catch { /* fall through */ }
    const models = await opencodeDriver.listModels()
    return models[0] || 'unknown'
  },
}

// ─── cursor driver ───────────────────────────────────────────────────

const cursorDriver: ModelDriver = {
  label: 'cursor',
  namespaced: false,
  switchHint: '例: /model gpt-5.2 / sonnet-4-thinking / claude-opus-4-6',

  listModels: () => new Promise((resolve) => {
    // cursor-agent emits:
    //   Available models
    //
    //   <id> - <display name>
    //   <id> - <display name>
    //   ...
    // (sometimes piped through ANSI colors — strip on parse).
    //
    // Bin resolution mirrors cursor adapter's: env override → PATH →
    // ~/.local/bin → /usr/local/bin → /opt. systemd-launched agim has
    // a stripped PATH that often misses ~/.local/bin, so the bare name
    // fails ENOENT even when the binary is sitting there.
    const bin = resolveCursorBin()
    const proc = spawn(bin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout?.on('data', d => out += d.toString())
    proc.on('close', () => {
      const ids: string[] = []
      // ANSI CSI strip. Build via RegExp constructor so the literal
      // ESC byte (0x1b) never lands in source (biome
      // noControlCharactersInRegex).
      const ansi = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')
      for (const lineRaw of out.split('\n')) {
        const line = lineRaw.replace(ansi, '').trim()
        if (!line) continue
        if (line.toLowerCase().startsWith('available models')) continue
        const m = line.match(/^([A-Za-z0-9._-]+)\s+-\s+/)
        if (m) ids.push(m[1])
      }
      resolve(ids)
    })
    proc.on('error', () => resolve([]))
  }),

  async resolveDefault(): Promise<string> {
    // ~/.cursor/cli-config.json carries model.modelId.
    try {
      const { readFile } = await import('node:fs/promises')
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const configPath = join(homedir(), '.cursor', 'cli-config.json')
      const raw = await readFile(configPath, 'utf-8')
      const config = JSON.parse(raw) as Record<string, unknown>
      const model = config.model as { modelId?: string } | undefined
      if (model?.modelId) return model.modelId
    } catch { /* fall through */ }
    const models = await cursorDriver.listModels()
    return models[0] || 'auto'
  },
}

const MODEL_DRIVERS: Record<string, ModelDriver> = {
  opencode: opencodeDriver,
  cursor: cursorDriver,
}

const SUPPORTED_AGENTS = Object.keys(MODEL_DRIVERS)

/** Per-session cache: last /models ordered result, indexed from 1 */
const sessionModelIndex = new Map<string, string[]>()

/** Per-agent list cache. Keyed by driver label. */
const modelListCache = new Map<string, ListCache<string[]>>()
/** Per-agent default-model cache. Keyed by driver label. */
const defaultModelCache = new Map<string, ListCache<string>>()

function invalidateModelCache(): void {
  modelListCache.clear()
  defaultModelCache.clear()
}

async function getModelList(driver: ModelDriver): Promise<string[]> {
  const cached = modelListCache.get(driver.label)
  if (cached && Date.now() - cached.ts < MODEL_LIST_TTL_MS) return cached.value
  const value = await driver.listModels()
  modelListCache.set(driver.label, { value, ts: Date.now() })
  return value
}

async function resolveDefaultModel(driver: ModelDriver): Promise<string> {
  const cached = defaultModelCache.get(driver.label)
  if (cached && Date.now() - cached.ts < MODEL_LIST_TTL_MS) return cached.value
  const value = await driver.resolveDefault()
  defaultModelCache.set(driver.label, { value, ts: Date.now() })
  return value
}

export async function handleModelCommand(args: string, ctx: RouteContext): Promise<string> {
  const { sub, rest } = parseModelArgs(args)

  if (sub === 'refresh') {
    invalidateModelCache()
    return '✅ 模型缓存已清空。下次 /models 将重新查询。'
  }

  const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  const activeAgent = session?.agent || ctx.defaultAgent
  const driver = MODEL_DRIVERS[activeAgent]
  if (!driver) {
    const switchHint = SUPPORTED_AGENTS.map((a) => `/${a === 'opencode' ? 'oc' : a === 'cursor' ? 'cs' : a}`).join(' / ')
    return `ℹ️ \`/model\` 在 \`${activeAgent}\` 下不可用。当前支持：${SUPPORTED_AGENTS.join(' / ')}\n\n切换：${switchHint}`
  }

  if (sub === 'list') {
    return handleModelList(driver, rest, ctx)
  }

  if (args.trim() === '') {
    return handleModelCurrent(driver, ctx)
  }

  return handleModelSwitch(driver, args.trim(), ctx)
}

async function handleModelList(driver: ModelDriver, filter: string, ctx: RouteContext): Promise<string> {
  const models = await getModelList(driver)
  const defaultModel = await resolveDefaultModel(driver)
  const lowered = filter.toLowerCase()
  const filtered = lowered ? models.filter(m => m.toLowerCase().includes(lowered)) : models

  if (filtered.length === 0) {
    if (filter) return `🔍 没有匹配 "${filter}" 的模型。`
    return `⚠️ 未能获取 ${driver.label} 的模型列表。请确认 CLI 已安装并已登录。`
  }

  const session = await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
  const current = session?.model || defaultModel

  let idx = 1
  const flat: { num: number; full: string }[] = []
  const groups = new Map<string, { num: number; short: string; full: string }[]>()
  for (const m of filtered) {
    if (driver.namespaced) {
      const parts = m.split('/')
      const prov = parts.length >= 2 ? parts.slice(0, -1).join('/') : m
      const short = parts.pop() as string
      if (!groups.has(prov)) groups.set(prov, [])
      groups.get(prov)?.push({ num: idx, short, full: m })
    } else {
      // Flat list — bucket under the driver label so the rendered card
      // still has a header line.
      if (!groups.has(driver.label)) groups.set(driver.label, [])
      groups.get(driver.label)?.push({ num: idx, short: m, full: m })
    }
    flat.push({ num: idx, full: m })
    idx++
  }

  sessionModelIndex.set(sessionKey(ctx), flat.map(f => f.full))

  let msg = `📋 ${driver.label} 模型列表 (${filtered.length})\n\n`
  for (const [prov, list] of groups) {
    msg += `**${prov}**\n`
    for (const { num, short, full } of list) {
      const tag = full === current ? ' ⭐' : ''
      msg += `  ${String(num).padStart(3, ' ')}. \`${short}\`${tag}\n`
    }
  }
  msg += `\n当前: \`${current}\` ⭐\n/model <名称> 或 /model #序号 切换\n/models refresh 强制刷新缓存`
  return msg
}

async function handleModelCurrent(driver: ModelDriver, ctx: RouteContext): Promise<string> {
  const session = await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
  const defaultModel = await resolveDefaultModel(driver)
  const current = session?.model || defaultModel
  return `🧠 当前 ${driver.label} 模型: \`${current}\`\n\n使用 /model <名称> 或 /model #序号 切换\n使用 /models 查看所有模型`
}

async function handleModelSwitch(driver: ModelDriver, input: string, ctx: RouteContext): Promise<string> {
  // /model #N (or /model N) — index lookup
  const indexMatch = input.match(/^#?(\d+)$/)
  if (indexMatch) {
    const num = parseInt(indexMatch[1], 10)
    const cached = sessionModelIndex.get(sessionKey(ctx))
    if (!cached || cached.length === 0) {
      return `⚠️ 没有缓存的模型列表。请先 /models 查看，再用 /model #序号 切换。`
    }
    if (num < 1 || num > cached.length) {
      return `⚠️ 序号 ${num} 无效。可用范围: 1 - ${cached.length}\n\n先 /models 查看完整列表。`
    }
    const model = cached[num - 1]
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
    await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { model })
    return `✅ ${driver.label} 模型已切换: \`${model}\``
  }

  // Namespaced drivers require `provider/model`; flat drivers accept bare names.
  if (driver.namespaced && !input.includes('/')) {
    return `⚠️ 模型格式: provider/model\n${driver.switchHint}\n或: /model #N (序号切换)\n\n先 /models 查看`
  }

  const models = await getModelList(driver)
  const exactMatch = models.find(m => m === input || (driver.namespaced && m.endsWith(`/${input}`)))
  if (!exactMatch && models.length > 0) {
    return `⚠️ 模型 "${input}" 不在 ${driver.label} 列表中。\n\n先 /models 查看可用模型。`
  }

  const resolved = exactMatch || input
  await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, ctx.defaultAgent)
  await sessionManager.patchSession(ctx.platform, ctx.channelId, ctx.threadId, { model: resolved })
  return `✅ ${driver.label} 模型已切换: \`${resolved}\``
}

/** Test-only diagnostic: clear caches between cases. */
export const _internal = { invalidateModelCache }
