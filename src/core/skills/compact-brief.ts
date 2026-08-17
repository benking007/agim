// compact-brief — auto-generate the short skill row used in system-prompt
// injection. Target shape: `name: 短标签(可选括号)` ≈ 36 chars, Chinese-first
// when the source description is Chinese.

/** Hard cap for compact inject rows (CJK or Latin). */
export const SHORT_ROW_DESCRIPTION_CHARS = 36

const LEADING_VERB = /^(?:查询|通过|获取|用于|This skill (?:should be|is) used when|Use this skill when|Use (?:this|when))\s*/i

export function stripSkillMarkup(raw: string): string {
  return (raw || '')
    .replace(/^\[ECC\]\s*/i, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** First sentence; English `.` only counts when followed by space/EOF. */
export function firstSentence(raw: string): string {
  const clean = stripSkillMarkup(raw)
  if (!clean) return ''
  const zh = clean.match(/^.*?[。！？]/)
  const en = clean.match(/^.*?[.!?](?=\s|$)/)
  const candidates = [zh?.[0], en?.[0]].filter((m): m is string => Boolean(m))
  const first = candidates.length > 0
    ? candidates.sort((a, b) => a.length - b.length)[0]
    : clean
  return first.replace(/[。！？.!]+$/u, '').trim()
}

function squeezeCjkSpaces(s: string): string {
  return s
    .replace(/ ?([A-Za-z0-9.]+) ?(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/([\u4e00-\u9fff]) (?=[A-Za-z0-9\u4e00-\u9fff])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function keepShortParen(inner: string): string {
  const compact = inner.replace(/\s*\/\s*/g, '/').replace(/\s+/g, '')
  // Slash lists are catalogs (标题/类型/日期) — drop. Keep 5W1H / 1-3年 / MCP.
  if (!compact || compact.includes('/') || compact.length > 16) return ''
  return `(${compact})`
}

function attachFirstQuote(left: string, rest: string): string {
  const q = rest.match(/[“"「]([^”"」]{2,18})[”"」]/)
  if (!q) return left
  const quote = q[1].replace(/\s+/g, '')
  if (left.includes(quote)) return left
  return `${left}("${quote}")`
}

/**
 * Compress a SKILL.md description into the inject-row brief.
 * Optional `brief` (frontmatter) wins, then this heuristic.
 */
export function compactSkillBrief(description: string, brief?: string): string {
  const explicit = (brief || '').trim()
  if (explicit) return capBrief(squeezeCjkSpaces(stripSkillMarkup(explicit)))

  let s = firstSentence(description)
  if (!s) return ''

  const dash = s.search(/——|—/)
  if (dash >= 4) {
    s = attachFirstQuote(s.slice(0, dash).trim(), s.slice(dash))
  } else {
    const colon = s.search(/：/)
    if (colon >= 4 && colon <= 28) s = s.slice(0, colon).trim()
  }

  s = s.replace(/（([^）]*)）/g, (_, inner: string) => keepShortParen(inner))
  s = s.replace(/\(([^)]*)\)/g, (_, inner: string) => keepShortParen(inner))

  s = s.replace(LEADING_VERB, '').trim()
  s = squeezeCjkSpaces(s)
  s = s.replace(/[，,；;]+$/u, '').trim()
  // Inject rows prefer the noun; drop catalog-ish suffixes.
  s = s.replace(/(?:列表|全文|专用)$/u, '')
  if (s.length > SHORT_ROW_DESCRIPTION_CHARS) {
    s = s.replace(/(?:数据)$/u, '')
  }
  return capBrief(s)
}

function capBrief(s: string): string {
  if (s.length <= SHORT_ROW_DESCRIPTION_CHARS) return s
  return `${s.slice(0, SHORT_ROW_DESCRIPTION_CHARS).trimEnd()}…`
}

/** Legacy first-sentence helper (full-description / tests). */
export function oneLineDescription(desc: string, maxChars: number = SHORT_ROW_DESCRIPTION_CHARS): string {
  const clean = stripSkillMarkup(desc)
  if (!clean) return ''
  const zh = clean.match(/^.*?[。！？]/)
  const en = clean.match(/^.*?[.!?](?=\s|$)/)
  const candidates = [zh?.[0], en?.[0]].filter((m): m is string => Boolean(m))
  const first = candidates.length > 0
    ? candidates.sort((a, b) => a.length - b.length)[0].trim()
    : clean
  if (first.length <= maxChars) return first
  return `${first.slice(0, maxChars).trimEnd()}…`
}
