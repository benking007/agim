/**
 * Parse Portal/desktop user message text that may contain web-upload
 * markers and composer mention chips:
 *   [图片附件：/abs/path]
 *   [文件附件：/abs/path (name, size)]
 *   [工作区]
 *   [工作区文件：rel/path]
 *   [工作区目录：rel/path]
 *   [技能：name]
 */

export type UserContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string }
  | { kind: 'file'; path: string; name: string; size?: string }
  | { kind: 'workspace' }
  | { kind: 'ws-file'; path: string; isDir: boolean }
  | { kind: 'skill'; name: string }

const MARKER_RE = /\[(图片附件|文件附件|image attachment|file attachment|工作区文件|工作区目录|技能|workspace file|workspace dir|skill)[：:]\s*([^\]]+)\]|\[(工作区|workspace)\]/gi

function parseFilePayload(payload: string): { path: string; name: string; size?: string } {
  const m = payload.match(/^(.*?)\s*\((.+?),\s*([^)]+)\)\s*$/)
  if (m?.[1] != null && m[2] != null && m[3] != null) {
    return {
      path: m[1].trim(),
      name: m[2].trim() || basenameFallback(m[1]),
      size: m[3].trim(),
    }
  }
  const path = payload.trim()
  return { path, name: basenameFallback(path) }
}

function basenameFallback(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || 'file'
}

export function parseUserMediaContent(content: string): UserContentSegment[] {
  if (!content) return []
  const out: UserContentSegment[] = []
  let last = 0
  const matches = Array.from(content.matchAll(MARKER_RE))
  for (const m of matches) {
    const index = m.index ?? 0
    if (index > last) {
      const text = content.slice(last, index)
      if (text.length > 0) {
        out.push({ kind: 'text', text })
      }
    }

    const bare = m[3]
    if (bare) {
      out.push({ kind: 'workspace' })
      last = index + m[0].length
      continue
    }

    const tagRaw = m[1]
    const payloadRaw = m[2]
    if (!tagRaw || payloadRaw == null) {
      last = index + m[0].length
      continue
    }
    const tag = tagRaw.toLowerCase()
    const payload = payloadRaw.trim()
    if (tag === '图片附件' || tag === 'image attachment') {
      out.push({ kind: 'image', path: payload })
    } else if (tag === '工作区文件' || tag === 'workspace file') {
      out.push({ kind: 'ws-file', path: payload, isDir: false })
    } else if (tag === '工作区目录' || tag === 'workspace dir') {
      out.push({ kind: 'ws-file', path: payload, isDir: true })
    } else if (tag === '技能' || tag === 'skill') {
      out.push({ kind: 'skill', name: payload })
    } else {
      const file = parseFilePayload(payload)
      out.push({ kind: 'file', path: file.path, name: file.name, size: file.size })
    }
    last = index + m[0].length
  }
  if (last < content.length) {
    const text = content.slice(last)
    if (text.length > 0) {
      out.push({ kind: 'text', text: text.replace(/^\n+/, '') })
    }
  }
  // Drop leading/trailing whitespace-only text segments from marker joins.
  return out.filter((s) => s.kind !== 'text' || s.text.trim().length > 0)
}

export function mediaFileApiUrl(absPath: string, threadId?: string): string {
  const q = new URLSearchParams({ path: absPath })
  if (threadId) q.set('threadId', threadId)
  return `/api/chat/media/file?${q.toString()}`
}

export function isPreviewableTextMime(mime: string): boolean {
  const m = mime.toLowerCase()
  return (
    m.startsWith('text/')
    || m.includes('json')
    || m.includes('xml')
    || m.includes('javascript')
    || m.includes('typescript')
    || m === 'application/pdf'
  )
}

export type UserContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'images'; paths: string[] }
  | { kind: 'files'; files: Array<{ path: string; name: string }> }
  | { kind: 'mention'; mention: Extract<UserContentSegment, { kind: 'workspace' | 'ws-file' | 'skill' }> }

/** Collapse consecutive image/file markers so thumbs can sit in one wrap grid.
 *  Mention chips stay inline (one block each) so they flow with text. */
export function groupUserContentBlocks(segments: UserContentSegment[]): UserContentBlock[] {
  const blocks: UserContentBlock[] = []
  for (const seg of segments) {
    if (seg.kind === 'text') {
      blocks.push({ kind: 'text', text: seg.text })
      continue
    }
    if (seg.kind === 'image') {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'images') last.paths.push(seg.path)
      else blocks.push({ kind: 'images', paths: [seg.path] })
      continue
    }
    if (seg.kind === 'file') {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'files') last.files.push({ path: seg.path, name: seg.name })
      else blocks.push({ kind: 'files', files: [{ path: seg.path, name: seg.name }] })
      continue
    }
    blocks.push({ kind: 'mention', mention: seg })
  }
  return blocks
}
