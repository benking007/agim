// memo-what-extract.ts — split user's free-text into a short `what` and
// full-text `memo` when they reply to a Telegram pin / venue prompt.
//
// Why this exists: telling users "请只回个短名词" is fighting human nature.
// People naturally say "我车暂时停这里，晚点过来取" — we should preserve
// that intent in `memo` AND extract a searchable noun ("车") into `what`.
//
// Strategy (in order, cheapest to richest):
//   1. Trim + short-circuit: if the text is already a short noun (≤6 CJK
//      chars / ≤16 ASCII chars and contains no sentence-terminating
//      punctuation), use it as both what and memo. No LLM call.
//   2. Heuristic peel: strip leading "我[的]?" / "本人[的]?" and a few
//      common temporal-state adverbs ("暂时" / "刚刚" / "刚才" / "今天"),
//      then peel off until we hit a verb-ish boundary character. If the
//      result is 1–6 chars, use it.
//   3. LLM extraction via callHelperAgent: ask the active agent for a
//      strict JSON object { what: <≤6 char noun> }. Hard 6s timeout +
//      400 char output cap — extraction is small.
//   4. Fallback: first 6 chars of the trimmed text (sliced, NOT byte-cut)
//      so we never block a save just because extraction failed.
//
// The full original text always lands in `memo`.

import { logger as rootLogger } from './logger.js'
import { callHelperForJson } from './agent-helper.js'

const log = rootLogger.child({ component: 'memo.extract' })

const SHORT_LIMIT = 6        // CJK char ceiling for "already short enough"
const ASCII_SHORT_LIMIT = 16 // ASCII fits more characters per concept
// Sentence-terminating punctuation only. Plain spaces are fine in a label
// ("gym bag", "coffee shop"), so we don't include \s here.
const PUNCT_RE = /[，。,.；;！!？?]/

// Leading prefixes that aren't the subject. Order matters — longest first
// so multi-char demonstratives ("这就是") win before single-char ones.
// Includes:
//   - subject pronouns: 我[的]? / 本人[的]?
//   - demonstratives + copula: 这[就]?是 / 那[就]?是 / 这是 / 那是
//     (handles "这是我公司地址" → after strip "这是" → "我公司地址")
const LEADING_PREFIX_RE = /^(本人的|本人|我的|我|这就是|那就是|这是|那是|这|那)/
// Adverbs / state words to peel after the subject pronoun. We only peel
// them if they sit between the pronoun and the noun.
const STATE_PREFIX_RE = /^(暂时|临时|刚才|刚刚|今天|这次|目前|现在|马上)/
// Non-anchored variant — used to find a state word sandwiched between the
// noun and the verb ("车暂时停" → cut at "暂时").
const STATE_WORD_RE = /(暂时|临时|刚才|刚刚|今天|这次|目前|现在|马上)/

/**
 * Decide whether the text is short enough to use as-is.
 *
 * Two guards beyond length:
 *   1. Sentence punctuation rules it out (caller probably wrote a full
 *      thought, the noun is buried inside).
 *   2. Leading pronoun ("我" / "我的" / "本人") rules it out even when short,
 *      because the user nearly always means a noun that follows the pronoun
 *      ("我车" → "车", not "我车"). We'd rather peel.
 */
function isShortEnough(s: string): boolean {
  if (PUNCT_RE.test(s)) return false
  if (LEADING_PREFIX_RE.test(s)) return false
  const cjkCount = (s.match(/[一-鿿]/g) ?? []).length
  if (cjkCount > 0) return s.length <= SHORT_LIMIT
  return s.length <= ASCII_SHORT_LIMIT
}

/**
 * Heuristic noun peel. Returns null if it can't confidently pick one.
 * Conservative — we'd rather punt to the LLM than emit a wrong guess.
 *
 *   "我车暂时停这里，晚点过来取"
 *     → strip 我      → "车暂时停这里…"
 *     → no state-prefix match here (车 isn't a state word)
 *     → peel until boundary chars (停/在/是/到/找/给/带/带/有/…)
 *     → "车"  ✓
 *
 *   "我把伞放前台了"
 *     → strip 我      → "把伞放前台了"
 *     → "把" isn't a noun — heuristic returns null, LLM gets it
 */
function heuristicExtract(s: string): string | null {
  let t = s.trim()
  // Peel leading prefixes iteratively — "这是我公司..." needs TWO passes
  // (strip "这是" → "我公司..." → strip "我" → "公司...").
  for (let i = 0; i < 4; i++) {
    const m = t.match(LEADING_PREFIX_RE)
    if (!m) break
    t = t.slice(m[0].length).trim()
  }
  // Strip state adverb if it sits right at the front (post-pronoun)
  const state = t.match(STATE_PREFIX_RE)
  if (state) t = t.slice(state[0].length).trim()
  if (!t) return null

  // Find the earliest boundary in `t` — verb-ish character OR mid-string
  // state-prefix word OR sentence punctuation. Whichever comes first wins,
  // so we keep just the leading noun phrase.
  //   "车暂时停"            → cut at "暂时" → "车"
  //   "公司地址，记录下"   → cut at "，"  → "公司地址"
  //   "X是Y"               → cut at "是"  → "X"
  const VERB_BOUNDARY = /[停放是在到找给带有去回送到挂搁掉留藏交]/
  const verbIdx = t.search(VERB_BOUNDARY)
  const stateIdx = t.search(STATE_WORD_RE)
  const punctIdx = t.search(PUNCT_RE)
  let cutIdx = -1
  for (const idx of [verbIdx, stateIdx, punctIdx]) {
    if (idx >= 0 && (cutIdx < 0 || idx < cutIdx)) cutIdx = idx
  }
  if (cutIdx <= 0) return null // nothing found, or boundary at idx 0
  const noun = t.slice(0, cutIdx).trim()
  if (!noun || noun.length > SHORT_LIMIT) return null
  // Reject if the candidate contains punctuation — that means we mis-peeled.
  if (PUNCT_RE.test(noun)) return null
  return noun
}

export interface ExtractInput {
  text: string
  platform: string
  channelId: string
  threadId: string
}

export interface ExtractResult {
  what: string
  memo: string | null
  method: 'short' | 'heuristic' | 'llm' | 'fallback'
}

/**
 * Extract `what` (short noun, ≤6 chars typical) from the user's free-form
 * reply, and return the full text as `memo` when extraction produced
 * something distinct from the input.
 *
 * Never throws. Worst case (LLM down, heuristic miss) returns a sliced
 * fallback so the save proceeds.
 */
export async function extractWhatAndMemo(opts: ExtractInput): Promise<ExtractResult> {
  const trimmed = opts.text.trim()
  if (!trimmed) {
    // Pathological — caller should have guarded. Return something safe.
    return { what: '记录', memo: null, method: 'fallback' }
  }

  if (isShortEnough(trimmed)) {
    return { what: trimmed, memo: null, method: 'short' }
  }

  const heur = heuristicExtract(trimmed)
  if (heur) {
    log.debug({ event: 'memo.extract.heuristic', input: trimmed, what: heur })
    return { what: heur, memo: trimmed, method: 'heuristic' }
  }

  // LLM path. Short focused prompt + JSON output. 6s timeout — if no agent
  // is registered or the call fails, we fall through to the slice fallback
  // and the save still happens.
  const SYSTEM = [
    'You extract a 1–6 character Chinese noun from a user message that they want to record as a memo title.',
    'Output JSON only, no prose: { "what": "<noun>" }',
    'Rules:',
    '- Pick the most concrete object/entity (car, umbrella, restaurant, person, etc.)',
    '- Strip pronouns (我/你/他), particles (的/把), adverbs (暂时/今天).',
    '- Output 1–6 CJK characters OR 1–16 ASCII characters. NEVER a full sentence.',
    '- If you cannot find a noun, output { "what": "" }.',
  ].join('\n')
  const result = await callHelperForJson<{ what?: unknown }>({
    platform: opts.platform,
    channelId: opts.channelId,
    threadId: opts.threadId,
    systemPrompt: SYSTEM,
    userPrompt: `Message: ${trimmed}`,
    timeoutMs: 6_000,
    maxOutputChars: 400,
  })

  const llmWhat = typeof result?.what === 'string' ? result.what.trim() : ''
  if (llmWhat && llmWhat.length > 0 && llmWhat.length <= SHORT_LIMIT * 4) {
    log.debug({ event: 'memo.extract.llm', input: trimmed, what: llmWhat })
    return { what: llmWhat.slice(0, 200), memo: trimmed, method: 'llm' }
  }

  // Last-resort fallback: slice the first few chars. Always ≤ SHORT_LIMIT
  // so the resulting `what` looks like a noun even if it isn't.
  const fallback = trimmed.slice(0, SHORT_LIMIT)
  log.info({
    event: 'memo.extract.fallback',
    input: trimmed,
    what: fallback,
    reason: 'heuristic + LLM both inconclusive',
  })
  return { what: fallback, memo: trimmed, method: 'fallback' }
}
