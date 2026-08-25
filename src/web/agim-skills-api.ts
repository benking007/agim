// agim-skills-api — admin REST for the in-process agim SKILL.md
// loader (P1 follow-up). Distinct from the pre-existing
// `/api/skills` which lists per-agent workspace skills (CLI agents'
// own SKILL.md trees); this one operates on the agim-owned loader
// from src/core/skills/loader.ts.
//
// Endpoints:
//   GET    /api/agim-skills                       -> { skills, count }
//   GET    /api/agim-skills/:name                 -> { meta, body }
//   POST   /api/agim-skills                       body { name, body } -> 201 { meta }
//   PUT    /api/agim-skills/:name                 body { body } -> 200 { meta }
//   DELETE /api/agim-skills/:name                 -> 200 / 404
//   POST   /api/agim-skills/refresh               -> 200 { count }
//
// Per-account skill CRUD is scoped by `runWithAccountUser`. The
// injection-block editor is admin-gated in server.ts — that body is
// injected into every agent prompt.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestUserId, isRequestAdmin } from './auth.js'
import { runWithAccountUser } from '../core/accounts.js'
import {
  listSkills, getSkillByName, readSkillBody, invalidateSkillsCache,
  writeSkillFile, deleteSkill,
  MAX_SKILL_BODY_CHARS,
  buildAutoInjectionBlock,
  readInjectionOverride, writeInjectionOverride, deleteInjectionOverride,
  injectionOverridePath,
  rankSkillBucket,
} from '../core/skills/loader.js'

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw.trim()) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

/** Dispatcher; returns true when handled. */
export async function handleAgimSkillsApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const userId = getRequestUserId(req)
  if (userId) return runWithAccountUser(userId, () => handleAgimSkillsApiInner(req, res, url))
  return handleAgimSkillsApiInner(req, res, url)
}

async function handleAgimSkillsApiInner(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/agim-skills' && m === 'GET') {
    await handleList(res); return true
  }
  if (p === '/api/agim-skills' && m === 'POST') {
    await handleCreate(req, res); return true
  }
  if (p === '/api/agim-skills/refresh' && m === 'POST') {
    invalidateSkillsCache()
    const skills = listSkills()
    send(res, 200, { count: skills.length })
    return true
  }
  // v1.2.151 — injection-block override editor. Operator-facing tunable
  // for the tier-1 system-prompt skill block that goes to every agent.
  // GET returns BOTH the auto-generated block (read-only preview) and
  // the current override (if any), so the SPA can show side-by-side.
  if (p === '/api/agim-skills/injection' && m === 'GET') {
    await handleInjectionGet(res); return true
  }
  if (p === '/api/agim-skills/injection' && m === 'PUT') {
    await handleInjectionPut(req, res); return true
  }
  if (p === '/api/agim-skills/injection' && m === 'DELETE') {
    await handleInjectionDelete(res); return true
  }
  const byName = p.match(/^\/api\/agim-skills\/([A-Za-z0-9._-]+)$/)
  if (byName && m === 'GET')    { await handleGet(res, byName[1]);    return true }
  if (byName && m === 'PUT')    { await handleUpdate(req, res, byName[1]); return true }
  if (byName && m === 'DELETE') { await handleDelete(req, res, byName[1]); return true }
  return false
}

// ─── handlers ───────────────────────────────────────────────────────

async function handleList(res: ServerResponse): Promise<void> {
  const skills = listSkills().map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source,
    always: s.always,
    available: s.available,
    unavailableReason: s.unavailableReason,
    requiresBins: s.requiresBins,
    requiresEnv: s.requiresEnv,
    dir: s.dir,
    // v1.2.152 — system-prompt injection bucket (0=agim framework /
    // 1=non-ECC builtin / 2=ECC top picks / 3=workspace / 4=ECC remainder).
    // SPA uses this to group + collapse the installed list so operators
    // with 300+ skills don't render one giant flat list.
    bucket: rankSkillBucket(s),
  }))
  send(res, 200, { skills, count: skills.length, maxBodyChars: MAX_SKILL_BODY_CHARS })
}

async function handleGet(res: ServerResponse, name: string): Promise<void> {
  const meta = getSkillByName(name)
  if (!meta) { send(res, 404, { error: `no skill named "${name}"` }); return }
  const body = readSkillBody(name)
  send(res, 200, { meta, body: body ?? '' })
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ name?: unknown; body?: unknown }>(req)
  if (!body || typeof body.name !== 'string' || typeof body.body !== 'string') {
    send(res, 400, { error: 'body { name, body } required' }); return
  }
  if (getSkillByName(body.name)) {
    send(res, 409, { error: `skill "${body.name}" already exists` }); return
  }
  const userId = isRequestAdmin(req) ? undefined : getRequestUserId(req)
  if (!isRequestAdmin(req) && !userId) {
    send(res, 403, { error: 'login required' }); return
  }
  const meta = writeSkillFile(body.name, body.body, userId ? { userId } : undefined)
  if (!meta) {
    send(res, 400, {
      error: 'write failed — invalid name (safe chars only) or invalid frontmatter (need name + description) or body > limit',
    })
    return
  }
  send(res, 201, { meta })
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  if (!getSkillByName(name)) {
    send(res, 404, { error: `no skill named "${name}"` }); return
  }
  const body = await readJsonBody<{ body?: unknown }>(req)
  if (!body || typeof body.body !== 'string') {
    send(res, 400, { error: 'body { body: string } required' }); return
  }
  const userId = isRequestAdmin(req) ? undefined : getRequestUserId(req)
  if (!isRequestAdmin(req) && !userId) {
    send(res, 403, { error: 'login required' }); return
  }
  const meta = writeSkillFile(name, body.body, userId ? { userId } : undefined)
  if (!meta) {
    send(res, 400, { error: 'write failed — invalid frontmatter or body > limit' })
    return
  }
  send(res, 200, { meta })
}

async function handleDelete(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  const meta = getSkillByName(name)
  if (!meta) {
    send(res, 404, { error: `no skill named "${name}"` }); return
  }
  if (meta.source === 'builtin') {
    send(res, 400, {
      error: 'cannot delete builtin skills; shadow with a workspace skill of the same name (POST /api/agim-skills) to override',
    })
    return
  }
  const userId = isRequestAdmin(req) ? undefined : getRequestUserId(req)
  if (!isRequestAdmin(req) && !userId) {
    send(res, 403, { error: 'login required' }); return
  }
  if (!isRequestAdmin(req) && meta.source !== 'user') {
    send(res, 403, { error: 'can only delete your own skills' }); return
  }
  const ok = deleteSkill(name, userId ? { userId } : undefined)
  if (!ok) { send(res, 500, { error: 'delete failed' }); return }
  send(res, 200, { name, deleted: true })
}

// ─── v1.2.151 — injection override (operator editor) ───────────────────

/** Hard cap on override payload size. The auto block tops out around
 *  ~10k chars on a large install; allow 4× headroom for operator
 *  free-text without enabling pathological prompt sizes. */
const INJECTION_OVERRIDE_MAX_CHARS = 40_000

async function handleInjectionGet(res: ServerResponse): Promise<void> {
  // Compute the auto block from the live loader state. Returned even
  // when an override exists so the SPA can preview "what auto would
  // produce right now" alongside the saved override.
  const all = listSkills()
  const auto = all.length === 0 ? '' : buildAutoInjectionBlock(all)
  const override = readInjectionOverride()
  send(res, 200, {
    auto,
    autoChars: auto.length,
    override,
    overrideChars: override?.length ?? 0,
    overridePath: injectionOverridePath(),
    overrideActive: override !== null,
    maxOverrideChars: INJECTION_OVERRIDE_MAX_CHARS,
  })
}

async function handleInjectionPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJsonBody<{ body?: unknown }>(req)
  if (!payload || typeof payload.body !== 'string') {
    send(res, 400, { error: 'body { body: string } required' }); return
  }
  const text = payload.body
  if (text.length > INJECTION_OVERRIDE_MAX_CHARS) {
    send(res, 413, {
      error: `override body exceeds ${INJECTION_OVERRIDE_MAX_CHARS} char limit`,
      length: text.length,
    })
    return
  }
  if (!text.trim()) {
    // Empty body == delete; the loader treats empty file as no-override.
    deleteInjectionOverride()
    send(res, 200, { saved: false, deleted: true })
    return
  }
  const ok = writeInjectionOverride(text)
  if (!ok) {
    send(res, 500, { error: 'failed to write override file' }); return
  }
  send(res, 200, { saved: true, length: text.length, path: injectionOverridePath() })
}

async function handleInjectionDelete(res: ServerResponse): Promise<void> {
  const had = readInjectionOverride() !== null
  const ok = deleteInjectionOverride()
  if (!ok) { send(res, 500, { error: 'failed to delete override file' }); return }
  send(res, 200, { deleted: had })
}
