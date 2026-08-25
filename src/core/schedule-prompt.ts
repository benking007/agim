// Schedule prompt prefix — model + artifacts live in the existing
// `prompt` column (no schema change). Portal wraps on create; the
// scheduler unwraps on fire; execution records parse the stored job
// prompt to show where outputs went.
//
// Shape (single line, then the operator prompt):
//   <!-- agim:schedule {"model":"deepseek-v4-pro","artifacts":"PROJECTS/gold-daily"} -->
//   Generate today's briefing.

export interface SchedulePromptMeta {
  model?: string
  artifacts?: string
}

const PREFIX_RE = /^<!--\s*agim:schedule\s+(\{.*\})\s*-->\s*\n?/

export function wrapSchedulePrompt(body: string, meta: SchedulePromptMeta): string {
  const payload: SchedulePromptMeta = {}
  const model = typeof meta.model === 'string' ? meta.model.trim() : ''
  const artifacts = sanitizeArtifactsRel(typeof meta.artifacts === 'string' ? meta.artifacts : '')
  if (model) payload.model = model
  if (artifacts) payload.artifacts = artifacts
  if (!payload.model && !payload.artifacts) return body
  return `<!-- agim:schedule ${JSON.stringify(payload)} -->\n${body}`
}

export function parseSchedulePrompt(raw: string): { meta: SchedulePromptMeta; body: string } {
  const text = typeof raw === 'string' ? raw : ''
  const match = PREFIX_RE.exec(text)
  if (!match) return { meta: {}, body: text }
  try {
    const json = match[1]
    if (!json) return { meta: {}, body: text }
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { meta: {}, body: text }
    }
    const rec = parsed as Record<string, unknown>
    const meta: SchedulePromptMeta = {}
    if (typeof rec.model === 'string' && rec.model.trim()) meta.model = rec.model.trim()
    const artifacts = sanitizeArtifactsRel(typeof rec.artifacts === 'string' ? rec.artifacts : '')
    if (artifacts) meta.artifacts = artifacts
    return { meta, body: text.slice(match[0].length) }
  } catch {
    return { meta: {}, body: text }
  }
}

/** Workspace-relative artifacts dir, or null when the value would escape. */
export function sanitizeArtifactsRel(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (!trimmed) return null
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null
  const parts = trimmed.split('/').filter((p) => p && p !== '.')
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..')) return null
  return parts.join('/')
}

export function artifactsInstruction(rel: string, abs?: string): string {
  const loc = abs ? `${rel} (${abs})` : rel
  return `\n\nWrite all outputs under this workspace-relative directory: ${loc}. Create it if missing. Mention the path in your final reply.`
}
