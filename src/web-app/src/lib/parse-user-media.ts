/**
 * Parse Portal/desktop user message text that may begin with web-upload
 * markers produced by `formatMediaMarker`:
 *   [图片附件：/abs/path]
 *   [文件附件：/abs/path (name, size)]
 */

export type UserContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string }
  | { kind: 'file'; path: string; name: string; size?: string }

const MARKER_RE = /\[(图片附件|文件附件|image attachment|file attachment)[：:]\s*([^\]]+)\]/gi

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
    const tagRaw = m[1]
    const payloadRaw = m[2]
    if (!tagRaw || payloadRaw == null) continue
    if (index > last) {
      const text = content.slice(last, index)
      if (text.trim().length > 0) {
        out.push({ kind: 'text', text })
      }
    }
    const tag = tagRaw.toLowerCase()
    const payload = payloadRaw.trim()
    if (tag === '图片附件' || tag === 'image attachment') {
      out.push({ kind: 'image', path: payload })
    } else {
      const file = parseFilePayload(payload)
      out.push({ kind: 'file', path: file.path, name: file.name, size: file.size })
    }
    last = index + m[0].length
  }
  if (last < content.length) {
    out.push({ kind: 'text', text: content.slice(last) })
  }
  // Drop leading/trailing whitespace-only text segments from marker joins.
  return out.filter((s) => s.kind !== 'text' || s.text.length > 0)
}

export function mediaFileApiUrl(absPath: string): string {
  return `/api/chat/media/file?path=${encodeURIComponent(absPath)}`
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
