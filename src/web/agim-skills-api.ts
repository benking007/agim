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
// All endpoints are admin-gated upstream in server.ts because SKILL.md
// bodies are injected into every agent prompt — malicious content
// here goes straight to every CLI agent + the native agent.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  listSkills, getSkillByName, readSkillBody, invalidateSkillsCache,
  writeSkillFile, deleteSkill,
  MAX_SKILL_BODY_CHARS,
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
  const byName = p.match(/^\/api\/agim-skills\/([A-Za-z0-9._-]+)$/)
  if (byName && m === 'GET')    { await handleGet(res, byName[1]);    return true }
  if (byName && m === 'PUT')    { await handleUpdate(req, res, byName[1]); return true }
  if (byName && m === 'DELETE') { await handleDelete(res, byName[1]); return true }
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
  const meta = writeSkillFile(body.name, body.body)
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
  const meta = writeSkillFile(name, body.body)
  if (!meta) {
    send(res, 400, { error: 'write failed — invalid frontmatter or body > limit' })
    return
  }
  send(res, 200, { meta })
}

async function handleDelete(res: ServerResponse, name: string): Promise<void> {
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
  const ok = deleteSkill(name)
  if (!ok) { send(res, 500, { error: 'delete failed' }); return }
  send(res, 200, { name, deleted: true })
}
