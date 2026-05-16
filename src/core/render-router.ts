// Render-router — decides how an agent's reply is delivered to an IM channel.
//
// Three modes:
//   - inline         : short, send as-is (with light markdown degradation).
//   - truncate-link  : long & no explicit summary — send first N chars + "..."
//                      + link to a saved paste on the agim web console.
//   - summary-link   : agent provided an explicit <im-summary> + <full-md>
//                      envelope — send the summary + link to the full content.
//
// The link target is the operator's own agim web console (viewer.public_base_url),
// which the operator exposes via reverse proxy / tunnel of their choice. Content
// is persisted locally via viewer-local.ts — it never leaves the operator's host.

export interface ViewerThresholds {
  /** Char count above which we consider the message "long". */
  chars: number
  /** Line count above which we consider the message "long". */
  lines: number
  /** Max single-code-block lines above which we route to web. */
  codeLines: number
}

export const DEFAULT_THRESHOLDS: ViewerThresholds = {
  chars: 500,
  lines: 12,
  codeLines: 10,
}

export type RenderMode = 'inline' | 'truncate-link' | 'summary-link'

export interface RenderDecision {
  mode: RenderMode
  /** mode === 'inline' — final text to send to IM (after light md degradation). */
  inlineText?: string
  /** mode === 'truncate-link' | 'summary-link' — the short bit shown in IM. */
  summary?: string
  /** mode === 'truncate-link' | 'summary-link' — the markdown to persist for /v/:id. */
  fullMd?: string
}

const SUMMARY_RE = /<im-summary>([\s\S]*?)<\/im-summary>\s*<full-md>([\s\S]*?)<\/full-md>/
const TABLE_RE = /(^|\n)\s*\|[^\n]+\|[^\n]*\n\s*\|?\s*[-:]+\s*\|/  // header + separator row
const FENCE_RE = /```[a-zA-Z0-9_+\-]*\n([\s\S]*?)\n```/g

export interface DecideOpts {
  thresholds?: ViewerThresholds
  /** Whether viewer is configured & enabled. If false we always inline. */
  viewerEnabled: boolean
}

export function decideRender(text: string, opts: DecideOpts): RenderDecision {
  const t = (text ?? '').trim()
  if (t.length === 0) return { mode: 'inline', inlineText: '' }

  // 1. Agent-provided summary envelope wins.
  const m = SUMMARY_RE.exec(t)
  if (m) {
    const summary = m[1].trim()
    const fullMd = m[2].trim()
    if (fullMd.length > 0 && opts.viewerEnabled) {
      return { mode: 'summary-link', summary, fullMd }
    }
    // Envelope present but viewer off — fall through to inline using summary only.
    return { mode: 'inline', inlineText: summary || fullMd }
  }

  const th = opts.thresholds ?? DEFAULT_THRESHOLDS

  // 2. Threshold check.
  if (!opts.viewerEnabled || !exceedsThreshold(t, th)) {
    return { mode: 'inline', inlineText: degradeMarkdown(t) }
  }

  // 3. Long & viewer enabled — truncate.
  return {
    mode: 'truncate-link',
    summary: firstNonEmpty(t, 200),
    fullMd: t,
  }
}

export function exceedsThreshold(text: string, t: ViewerThresholds): boolean {
  if (text.length > t.chars) return true
  if (text.split('\n').length > t.lines) return true
  if (TABLE_RE.test(text)) return true
  if (maxCodeBlockLines(text) >= t.codeLines) return true
  return false
}

function maxCodeBlockLines(text: string): number {
  let max = 0
  let m: RegExpExecArray | null
  FENCE_RE.lastIndex = 0
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lines = m[1].split('\n').length
    if (lines > max) max = lines
  }
  return max
}

/**
 * Take the first non-empty paragraph (up to N chars), suitable as a one-glance
 * "what's this about" tease before the user clicks through to the full page.
 */
export function firstNonEmpty(text: string, maxChars: number): string {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paras.length === 0) return text.slice(0, maxChars)
  const head = paras[0]
  if (head.length <= maxChars) return head
  return head.slice(0, maxChars - 1).trimEnd() + '…'
}

/**
 * Light markdown → IM-friendly degradation for inline mode. We DON'T strip
 * inline emphasis (most IMs render * and _ acceptably). We DO drop the very
 * heavy structures (tables, deep headings) since they look terrible on WeChat
 * etc. Code fences are kept (Telegram renders them; WeChat shows the backticks
 * as plain text which is fine).
 */
export function degradeMarkdown(text: string): string {
  let out = text
  // Heading levels: keep the text, drop the ### prefix (IMs don't render font sizes).
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  // Horizontal rules: drop.
  out = out.replace(/^\s{0,3}(?:[-_*]\s?){3,}\s*$/gm, '')
  return out
}

/**
 * Build the system-style hint prepended to user prompts when viewer is
 * enabled. Tells the agent to wrap long answers in <im-summary>/<full-md>.
 * Returns empty string when viewer is disabled so the prompt is unchanged.
 */
export function buildViewerHintSnippet(opts: {
  viewerEnabled: boolean
  thresholds?: ViewerThresholds
}): string {
  if (!opts.viewerEnabled) return ''
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS
  return [
    '[IM-render hint]',
    `Your reply is delivered to an IM channel where rich markdown (tables, long code blocks, deep headings) renders poorly.`,
    `When your answer exceeds ~${t.lines} lines or ~${t.chars} characters, OR includes a markdown table, OR a code block of ~${t.codeLines}+ lines,`,
    `wrap it in this two-section envelope (and nothing outside the envelope):`,
    '',
    '<im-summary>',
    '1–3 short lines the user sees in chat. State the conclusion or key result here.',
    '</im-summary>',
    '<full-md>',
    'The full markdown answer (tables, code, details). This renders on a web page the user opens by tapping a link.',
    '</full-md>',
    '',
    'For shorter answers, reply normally without the envelope.',
    '[/IM-render hint]',
  ].join('\n')
}
