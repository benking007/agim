// workspace-skills-api — Workspace agent skills browser (claude/opencode SKILL.md).
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Note: this module covers locally-installed claude/opencode skills under
// ~/.claude/skills and ~/.config/opencode/skills. It is DISTINCT from
// src/web/agim-skills-api.ts which manages agim's own built-in skill store.
//
// Endpoints:
//   GET /api/skills              → list all installed skills   — any authenticated peer
//   GET /api/skills/remote/hot   → top-50 from skillhub.cn    — any authenticated peer
//   GET /api/skills/:slug        → full SKILL.md content       — any authenticated peer

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sendJson } from './http-utils.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleWorkspaceSkillsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/skills' && m === 'GET') {
    await handleSkillsList(req, res); return true
  }
  if (p === '/api/skills/remote/hot' && m === 'GET') {
    await handleSkillsRemoteHot(req, res); return true
  }
  const skillDetailMatch = p.match(/^\/api\/skills\/([A-Za-z0-9._-]+)$/)
  if (skillDetailMatch && m === 'GET') {
    await handleSkillDetail(req, res, skillDetailMatch[1]); return true
  }
  return false
}

interface SkillMeta {
  slug: string
  name: string
  description: string
  category: string
  agents: ('claude' | 'opencode')[]
  path: string
}

export function inferCategory(slug: string): string {
  if (slug.startsWith('fin-data-') || slug.startsWith('mx_') || slug.startsWith('ttfund-')
      || slug.startsWith('ash-') || slug.startsWith('low-position-pick')
      || slug.startsWith('overnight-') || slug.startsWith('garp-')
      || slug.startsWith('gold') || slug === 'precious-metals-report') return '金融数据 / 行情'
  if (slug.startsWith('white-pig-') || slug.startsWith('add-white-pig')
      || slug.startsWith('renew-white-pig') || slug.startsWith('deduct-white-pig')
      || slug.startsWith('delete-white-pig') || slug.startsWith('modify-white-pig')
      || slug.startsWith('add-white-pig-') || slug.startsWith('query-account')
      || slug.startsWith('query-white-pig') || slug.startsWith('set-kol')
      || slug.startsWith('statistics-sales')) return '白猪运营'
  if (slug.startsWith('metaso-') || slug === 'multi-search-engine'
      || slug === 'news-summary' || slug === 'global-financial-headlines'
      || slug.startsWith('qveris')) return '搜索 / 资讯'
  if (slug.startsWith('mailsender') || slug === 'sendmail') return '邮件 / 通讯'
  if (slug.startsWith('claude-api') || slug === 'security-review' || slug === 'review'
      || slug === 'simplify' || slug === 'first-principles-decomposer'
      || slug === 'session_summary' || slug === 'init') return '开发 / 评审'
  if (slug === 'find-skills' || slug === 'update-config' || slug === 'keybindings-help'
      || slug === 'fewer-permission-prompts' || slug === 'loop' || slug === 'schedule'
      || slug === 'yanshen-manual') return '元能力 / 平台'
  return '其他'
}

export function readSkillFrontmatter(skillMdPath: string): { name?: string; description?: string } | null {
  try {
    const raw = readFileSync(skillMdPath, 'utf-8')
    if (!raw.startsWith('---')) return null
    const end = raw.indexOf('\n---', 3)
    if (end < 0) return null
    const fm = raw.slice(3, end)
    const out: { name?: string; description?: string } = {}
    for (const line of fm.split('\n')) {
      const m = line.match(/^(\w+)\s*:\s*(.+?)\s*$/)
      if (!m) continue
      const k = m[1].toLowerCase()
      const v = m[2].replace(/^["']|["']$/g, '')
      if (k === 'name') out.name = v
      else if (k === 'description') out.description = v
    }
    return out
  } catch { return null }
}

export function scanSkillDir(rootDir: string): Array<{ slug: string; skillMd: string }> {
  try {
    if (!existsSync(rootDir)) return []
    const out: Array<{ slug: string; skillMd: string }> = []
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const md = join(rootDir, entry.name, 'SKILL.md')
      if (existsSync(md)) out.push({ slug: entry.name, skillMd: md })
    }
    return out
  } catch { return [] }
}

const HOME = process.env.HOME || '/root'
const CLAUDE_SKILLS = `${HOME}/.claude/skills`
const OPENCODE_SKILLS = `${HOME}/.config/opencode/skills`

export function listSkills(): SkillMeta[] {
  const fromClaude = scanSkillDir(CLAUDE_SKILLS)
  const fromOpencode = scanSkillDir(OPENCODE_SKILLS)
  const map = new Map<string, SkillMeta>()
  for (const { slug, skillMd } of fromClaude) {
    const fm = readSkillFrontmatter(skillMd)
    if (!fm?.name) continue
    map.set(slug, {
      slug,
      name: fm.name,
      description: fm.description || '',
      category: inferCategory(slug),
      agents: ['claude'],
      path: skillMd,
    })
  }
  for (const { slug, skillMd } of fromOpencode) {
    const fm = readSkillFrontmatter(skillMd)
    if (!fm?.name) continue
    const existing = map.get(slug)
    if (existing) {
      if (!existing.agents.includes('opencode')) existing.agents.push('opencode')
    } else {
      map.set(slug, {
        slug,
        name: fm.name,
        description: fm.description || '',
        category: inferCategory(slug),
        agents: ['opencode'],
        path: skillMd,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category)
    return a.slug.localeCompare(b.slug)
  })
}

export let remoteHotCache: { fetchedAt: number; data: unknown } | null = null
const REMOTE_HOT_TTL_MS = 5 * 60_000

export function isSkillhubEnabled(): boolean {
  const v = (process.env.AGIM_SKILLHUB_ENABLED ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
}

async function handleSkillsList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const skills = listSkills()
    const byCategory: Record<string, number> = {}
    for (const s of skills) byCategory[s.category] = (byCategory[s.category] || 0) + 1
    sendJson(res, 200, {
      total: skills.length,
      byCategory,
      skills,
      sources: { claude: CLAUDE_SKILLS, opencode: OPENCODE_SKILLS },
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleSkillsRemoteHot(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isSkillhubEnabled()) {
    sendJson(res, 200, { disabled: true, items: [], reason: 'AGIM_SKILLHUB_ENABLED=0' })
    return
  }
  try {
    if (remoteHotCache && Date.now() - remoteHotCache.fetchedAt < REMOTE_HOT_TTL_MS) {
      sendJson(res, 200, { ...(remoteHotCache.data as Record<string, unknown>), cached: true, fetchedAt: remoteHotCache.fetchedAt })
      return
    }
    const r = await fetch('https://api.skillhub.cn/api/v1/showcase/hot', {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    })
    if (!r.ok) {
      if (remoteHotCache) {
        sendJson(res, 200, { ...(remoteHotCache.data as Record<string, unknown>), cached: true, fetchedAt: remoteHotCache.fetchedAt, stale: true, upstreamStatus: r.status })
        return
      }
      sendJson(res, 502, { error: `skillhub upstream ${r.status}` })
      return
    }
    const json = await r.json() as Record<string, unknown>
    remoteHotCache = { fetchedAt: Date.now(), data: json }
    sendJson(res, 200, { ...json, cached: false, fetchedAt: remoteHotCache.fetchedAt })
  } catch (err) {
    if (remoteHotCache) {
      sendJson(res, 200, {
        ...(remoteHotCache.data as Record<string, unknown>),
        cached: true, fetchedAt: remoteHotCache.fetchedAt, stale: true,
        upstreamError: err instanceof Error ? err.message : String(err),
      })
      return
    }
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleSkillDetail(_req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  try {
    if (!/^[A-Za-z0-9._-]+$/.test(slug)) {
      sendJson(res, 400, { error: 'bad slug' })
      return
    }
    const skills = listSkills()
    const meta = skills.find((s) => s.slug === slug)
    if (!meta) {
      sendJson(res, 404, { error: 'skill not found' })
      return
    }
    const raw = readFileSync(meta.path, 'utf-8')
    sendJson(res, 200, { ...meta, content: raw })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
