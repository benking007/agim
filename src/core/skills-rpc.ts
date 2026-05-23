// skills-rpc — agim-side handler for mcp__imhub__read_skill
// (Stage 3 / P0 #3 tier-2 fetch).
//
// The skills loader's tier-1 (name + description) is auto-injected into
// every system prompt; this RPC powers tier-2 (full body) on-demand
// loading so the agent only pays the token cost for skills it actually
// decides to use.
//
// Wire format (sidecar -> bus):
//   { v:1, type:'skill', runId, reqId, payload:{op:'read', name:string} }
// Response:
//   { v:1, type:'skill.result', reqId, ok, result?:{name, body, available, requires}, error? }

import { logger as rootLogger } from './logger.js'
import {
  getSkillByName, readSkillBody,
  invalidateSkillsCache, listSkills,
} from './skills/loader.js'

const log = rootLogger.child({ component: 'skills-rpc' })

export interface SkillsPayload {
  op?: unknown
  name?: unknown
}

export type SkillsResult =
  | {
      ok: true
      result:
        | { op: 'read'; name: string; body: string; available: boolean; unavailableReason?: string }
        | { op: 'list'; skills: Array<{ name: string; description: string; source: string; available: boolean; always: boolean }> }
        | { op: 'refresh'; total: number }
    }
  | { ok: false; error: string }

/**
 * Single entry point — the bus picks `op` and we dispatch. Three ops
 * supported in this initial cut:
 *
 *   - 'read' (default): return one skill's full body. Agent uses this
 *     when its tier-1 summary description matches user intent.
 *   - 'list':           return the full skill roster. Useful when the
 *     agent wants to introspect what's available without scrolling the
 *     entire system prompt.
 *   - 'refresh':        force a disk re-scan. Operator-only in spirit;
 *     we don't enforce, but the operation is cheap enough that abuse
 *     just wastes the calling agent's iteration budget.
 */
export async function handleSkillsOp(payload: SkillsPayload): Promise<SkillsResult> {
  const op = typeof payload.op === 'string' ? payload.op : 'read'

  if (op === 'list') {
    const skills = listSkills().map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      available: s.available,
      always: s.always,
    }))
    return { ok: true, result: { op: 'list', skills } }
  }

  if (op === 'refresh') {
    invalidateSkillsCache()
    const total = listSkills().length
    log.info({ event: 'skills.rpc.refresh', total })
    return { ok: true, result: { op: 'refresh', total } }
  }

  if (op === 'read') {
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) return { ok: false, error: 'read: name is required (non-empty string)' }
    const meta = getSkillByName(name)
    if (!meta) return { ok: false, error: `unknown skill: ${name}` }
    const body = readSkillBody(name)
    if (body === null) {
      return { ok: false, error: `failed to read body for skill ${name} (file moved / permission denied?)` }
    }
    return {
      ok: true,
      result: {
        op: 'read',
        name: meta.name,
        body,
        available: meta.available,
        ...(meta.unavailableReason ? { unavailableReason: meta.unavailableReason } : {}),
      },
    }
  }

  return { ok: false, error: `unknown op: ${op} (expected read | list | refresh)` }
}
