/**
 * Hard inline delivery for Web / Portal (`/m/chat`, macOS·iOS shells) / TUI.
 *
 * IM channels may summarize + Viewer-link. These surfaces already render
 * full markdown — summary-only replies (envelope or 「落盘+要点」) are
 * expanded at the delivery boundary so the user always sees the body.
 * This does not depend on AGENTS.md / prompt compliance.
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { isViewerApplicablePlatform } from './viewer-config.js'

const SUMMARY_ENVELOPE_RE =
  /<im-summary>([\s\S]*?)<\/im-summary>\s*<full-md>([\s\S]*?)<\/full-md>/i
const STRAY_ENVELOPE_TAG_RE = /<\/?(?:im-summary|full-md)>/gi

/** Chinese / English archive pointers the model commonly emits. */
const ARCHIVE_PATH_RE =
  /(?:报告已落盘|已落盘|正文已落盘|已归档|归档[至到在]|saved\s+to|wrote\s+to|archived\s+(?:to|at)|report\s+saved\s+(?:to|at))[：:\s]+[`'"]?([^\s`'"]+?\.(?:md|markdown))[`'"]?/i

/** Safety cap so a huge on-disk dump cannot blow the WS / session row. */
export const INLINE_DELIVERY_MAX_CHARS = 400_000

export function needsFullInlineDelivery(platform: string): boolean {
  return !isViewerApplicablePlatform(platform)
}

function stripStrayEnvelopeTags(s: string): string {
  return s.replace(STRAY_ENVELOPE_TAG_RE, '').trim()
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const base = normalize(resolve(root)) + sep
  const target = normalize(resolve(candidate))
  return target === normalize(resolve(root)) || target.startsWith(base)
}

export function resolveArchivedMarkdownPath(
  workspaceRoot: string,
  relOrPath: string,
): string | null {
  const raw = (relOrPath || '').trim()
  if (!raw || raw.includes('\0')) return null
  if (isAbsolute(raw)) return null
  if (raw.includes('..')) return null
  const abs = resolve(workspaceRoot, raw)
  if (!isPathInsideRoot(workspaceRoot, abs)) return null
  if (!/\.(md|markdown)$/i.test(abs)) return null
  return abs
}

function defaultReadFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8')
  } catch {
    return null
  }
}

export interface ExpandInlineOpts {
  /** Agent workspace root for resolving relative archive paths. */
  workspaceRoot?: string
  /** Test seam — override filesystem reads. */
  readFile?: (absPath: string) => string | null
}

/**
 * Expand summary-only shapes into the full body for inline channels.
 *
 * 1. `<im-summary>…</im-summary><full-md>…</full-md>` → deliver full-md
 * 2. 「报告已落盘：path.md」+ short chat → append file contents when longer
 */
export function expandInlineChannelReply(text: string, opts: ExpandInlineOpts = {}): string {
  // Preserve the original string when we do not expand — trim() would
  // silently drop trailing spaces and break identity checks in delivery tests.
  if (typeof text !== 'string') return text
  if (!text.trim()) return text

  const envelope = SUMMARY_ENVELOPE_RE.exec(text)
  if (envelope) {
    const fullMd = stripStrayEnvelopeTags(envelope[2] ?? '')
    if (fullMd.length > 0) {
      return fullMd.length > INLINE_DELIVERY_MAX_CHARS
        ? fullMd.slice(0, INLINE_DELIVERY_MAX_CHARS)
        : fullMd
    }
  }

  const pathMatch = ARCHIVE_PATH_RE.exec(text)
  const root = opts.workspaceRoot?.trim()
  if (pathMatch && root) {
    const abs = resolveArchivedMarkdownPath(root, pathMatch[1] ?? '')
    if (abs) {
      const reader = opts.readFile ?? defaultReadFile
      const fileBody = (reader(abs) ?? '').trim()
      if (fileBody) {
        const probe = fileBody.slice(0, Math.min(160, fileBody.length))
        const alreadyInlined = probe.length >= 40 && text.includes(probe)
        const looksLikeDigest = fileBody.length > text.length + 200
        if (!alreadyInlined && looksLikeDigest) {
          const merged = `${text.trimEnd()}\n\n---\n\n${fileBody}`
          return merged.length > INLINE_DELIVERY_MAX_CHARS
            ? merged.slice(0, INLINE_DELIVERY_MAX_CHARS)
            : merged
        }
      }
    }
  }

  // Only scrub stray envelope tags when present; otherwise return as-is.
  STRAY_ENVELOPE_TAG_RE.lastIndex = 0
  if (!STRAY_ENVELOPE_TAG_RE.test(text)) return text
  return stripStrayEnvelopeTags(text)
}
