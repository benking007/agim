// Shared message splitting utility
// Used by WeChat, Telegram, and other messengers with character limits

export interface SplitOptions {
  /** Maximum characters per chunk */
  maxLength?: number
  /** Add continuation marker to split messages */
  addContinuationMarker?: boolean
  /** Continuation marker text */
  continuationMarker?: string
}

/**
 * If `idx` falls between a UTF-16 surrogate pair, step back by 1 so the
 * pair stays whole. JavaScript strings are UTF-16; characters in plane 1+
 * (most emoji, e.g. 😀 U+1F600) are encoded as a high-surrogate +
 * low-surrogate pair (2 code units). Slicing through the boundary yields
 * an orphan surrogate that renders as `□` (or worse, breaks Telegram's
 * HTML parser when the orphan happens to be inside a tag value).
 *
 * Returns the safe split point. Idempotent on already-safe boundaries.
 */
function safeSplitPoint(s: string, idx: number): number {
  if (idx <= 0 || idx >= s.length) return idx
  const code = s.charCodeAt(idx - 1)
  if (code >= 0xD800 && code <= 0xDBFF) return idx - 1
  return idx
}

/**
 * Split a long message into chunks that fit within messenger limits.
 * Tries to split at natural boundaries (code blocks, paragraphs, lines).
 */
export function splitMessage(
  text: string,
  options: SplitOptions = {}
): string[] {
  const {
    maxLength = 2000,
    addContinuationMarker = true,
    continuationMarker = '\n\n[continued...]',
  } = options

  if (text.length <= maxLength) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLength) {
    // Try to split at code block boundary first
    let splitPoint = remaining.lastIndexOf('\n```\n', maxLength)
    if (splitPoint < maxLength / 2) {
      // Try paragraph break
      splitPoint = remaining.lastIndexOf('\n\n', maxLength)
    }
    if (splitPoint < maxLength / 2) {
      // Try line break
      splitPoint = remaining.lastIndexOf('\n', maxLength)
    }
    if (splitPoint < maxLength / 2) {
      // Force split at maxLength
      splitPoint = maxLength
    }
    // M10: surrogate-pair safety. The natural-boundary searches land on
    // ASCII bytes (newline, backtick) so they're already safe; the forced
    // split at maxLength is the only path that could land mid-pair.
    splitPoint = safeSplitPoint(remaining, splitPoint)

    chunks.push(remaining.slice(0, splitPoint).trim())
    remaining = remaining.slice(splitPoint).trim()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  // Add continuation markers
  if (addContinuationMarker && chunks.length > 1) {
    for (let i = 0; i < chunks.length - 1; i++) {
      chunks[i] += continuationMarker
    }
  }

  return chunks
}
