// auto-compact — shrink long native chat histories before they hit the
// provider call.
//
// Why: native uses single-shot 30-minute IM turns. A user who chats
// back and forth for hours accumulates many user/assistant pairs (plus
// any tool messages from earlier mcp__imhub__* calls). Past ~15k
// tokens the provider call cost climbs linearly and we get closer to
// the model's context window. Most older content is "settled" — the
// agent's earlier conclusions, not the live problem — so a 1-2 paragraph
// summary preserves continuity at a fraction of the tokens.
//
// Strategy (intentionally simple):
//   1. Cheap char-count proxy for tokens (chars ≈ 4 tokens for mixed
//      EN/CN). When total < TRIGGER chars, do nothing.
//   2. Always keep the original system prompt (caller handles), the
//      last KEEP_TURNS user/assistant pairs verbatim, plus any tool
//      messages that immediately precede them (so tool round-trips
//      stay valid for the provider).
//   3. Send the older slice to a cheap/evaluator role with a fixed
//      "summarize the prior conversation" instruction. Inject the
//      summary as a synthetic user message at index 0:
//         "[earlier conversation summary]\n<summary>\n[/earlier]"
//   4. On any failure, log + return the original array. Better a
//      slower turn than a broken one.

import type { LlmProvider, LlmMessage } from './provider-base.js'
import { getProvider } from './registry.js'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ component: 'auto-compact' })

export interface CompactOptions {
  /** Total char budget that triggers compaction. Default 60_000
   *  (~15k tokens for mixed EN/CN). Set via env IMHUB_NATIVE_COMPACT_TRIGGER_CHARS. */
  triggerChars?: number
  /** Number of recent user+assistant pairs preserved verbatim.
   *  Default 6 (= 12 messages, plus any tool messages between them).
   *  Set via env IMHUB_NATIVE_COMPACT_KEEP_TURNS. */
  keepTurns?: number
  /** Provider to ask for the summary. If omitted, tries evaluator →
   *  cheap → native-chat in that order; the first registered wins. */
  summarizer?: LlmProvider
  /** Hard cap on the summary length (chars) the summarizer is asked
   *  to produce. Default 1_500. */
  summaryCharCap?: number
}

export interface CompactResult {
  messages: LlmMessage[]
  compacted: boolean
  /** When compacted=true, how many of the original messages were
   *  collapsed into the synthetic summary entry. */
  collapsedCount: number
  /** When compacted=true, char count of the summary block (so the
   *  caller can log "compacted X chars to Y chars"). */
  summaryChars: number
  /** Char count of the original message array (sum of content). */
  originalChars: number
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function totalChars(messages: LlmMessage[]): number {
  let sum = 0
  for (const m of messages) sum += (m.content || '').length
  return sum
}

function resolveSummarizer(): LlmProvider | null {
  for (const role of ['evaluator', 'cheap', 'native-chat']) {
    const p = getProvider(role)
    if (p) return p
  }
  return null
}

/**
 * Pick the slice index such that messages[idx..] are the "recent" turns
 * we preserve verbatim. The slice MUST start on `role:'user'` so the
 * provider doesn't see an orphan `role:'tool'` whose matching
 * `assistant.toolCalls` was just compacted away (OpenAI / DeepSeek
 * reject the request with HTTP 400 in that case).
 *
 * Strategy: walk backwards counting user messages until we've covered
 * `keepTurns` user turns, then return the index of that user message.
 * If we couldn't find any user message, return 0 (no compaction).
 */
function pickKeepSliceIndex(messages: LlmMessage[], keepTurns: number): number {
  let pairs = 0
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      pairs += 1
      lastUserIdx = i
      if (pairs >= keepTurns) return i
    }
  }
  return Math.max(0, lastUserIdx)
}

/**
 * Compact if needed. Returns the (possibly new) message array plus a
 * summary metadata record. Never throws; on failure returns the input
 * unchanged with compacted=false.
 */
export async function maybeCompactHistory(
  messages: LlmMessage[],
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const triggerChars = opts.triggerChars ?? envInt('IMHUB_NATIVE_COMPACT_TRIGGER_CHARS', 60_000)
  const keepTurns = opts.keepTurns ?? envInt('IMHUB_NATIVE_COMPACT_KEEP_TURNS', 6)
  const summaryCharCap = opts.summaryCharCap ?? envInt('IMHUB_NATIVE_COMPACT_SUMMARY_CHARS', 1_500)

  const originalChars = totalChars(messages)
  // Disabled when trigger=0 (operator opt-out).
  if (triggerChars === 0) return { messages, compacted: false, collapsedCount: 0, summaryChars: 0, originalChars }
  if (originalChars < triggerChars) return { messages, compacted: false, collapsedCount: 0, summaryChars: 0, originalChars }

  const sliceIdx = pickKeepSliceIndex(messages, keepTurns)
  if (sliceIdx === 0) {
    // Nothing to summarise — the recent slice covers everything.
    return { messages, compacted: false, collapsedCount: 0, summaryChars: 0, originalChars }
  }
  const older = messages.slice(0, sliceIdx)
  const recent = messages.slice(sliceIdx)

  const summarizer = opts.summarizer ?? resolveSummarizer()
  if (!summarizer) {
    log.warn({ event: 'auto-compact.no_summarizer', originalChars, sliceIdx })
    return { messages, compacted: false, collapsedCount: 0, summaryChars: 0, originalChars }
  }

  // Render the older slice as a transcript the summarizer can read.
  const transcript = older.map((m) => {
    const tag = m.role === 'tool' ? `tool[${m.toolCallId ?? '?'}]` : m.role
    return `${tag}: ${m.content}`
  }).join('\n---\n')

  const summaryPrompt = [
    `You are summarising the earlier part of a chat conversation so it can be dropped from the active context window without losing continuity.`,
    `Keep ${summaryCharCap} characters or fewer. Preserve: user's stated goals, key facts the agent established, important tool results (e.g. lookups, IDs, file paths), and any open questions. Drop: small-talk, retries, intermediate reasoning.`,
    `Output a single paragraph (or short bulleted list) in the user's language — do not address the user directly.`,
    ``,
    `Conversation to summarise:`,
    transcript,
  ].join('\n')

  try {
    const r = await summarizer.chat(
      [{ role: 'user', content: summaryPrompt }],
      { temperature: 0, maxTokens: Math.max(256, Math.floor(summaryCharCap / 3)) },
    )
    const summary = (r.text || '').trim()
    if (!summary) {
      log.warn({ event: 'auto-compact.empty_summary', backend: summarizer.name })
      return { messages, compacted: false, collapsedCount: 0, summaryChars: 0, originalChars }
    }
    const synthetic: LlmMessage = {
      role: 'user',
      content: `[earlier conversation summary — ${older.length} messages compacted]\n${summary}\n[/earlier conversation summary]`,
    }
    log.info({
      event: 'auto-compact.applied',
      backend: summarizer.name,
      originalChars,
      collapsedCount: older.length,
      keptCount: recent.length,
      summaryChars: synthetic.content.length,
    })
    return {
      messages: [synthetic, ...recent],
      compacted: true,
      collapsedCount: older.length,
      summaryChars: synthetic.content.length,
      originalChars,
    }
  } catch (err) {
    log.warn({
      event: 'auto-compact.summarizer_failed',
      backend: summarizer.name,
      err: err instanceof Error ? err.message : String(err),
    })
    return { messages, compacted: false, collapsedCount: 0, summaryChars: 0, originalChars }
  }
}
