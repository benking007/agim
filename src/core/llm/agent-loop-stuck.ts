// agent-loop-stuck — stuck-loop detection helpers for the agent loop.
// Extracted from agent-loop.ts; agent-loop.ts is now a re-export facade.

import type { ToolCallReport } from './agent-loop-types.js'

/**
 * Deterministic JSON.stringify with sorted object keys at every level.
 * Used by the stuck-loop detector to derive a stable identity key for
 * tool-call arguments: identical calls hash to identical strings
 * regardless of key insertion order. Tolerates circular references and
 * non-JSON-able values by collapsing them to a placeholder.
 */
export function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return 'null'
  if (typeof value === 'undefined') return 'null'
  if (typeof value === 'function') return '"[fn]"'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (seen.has(value as object)) return '"[circular]"'
  seen.add(value as object)
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, seen)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`).join(',')}}`
}

/**
 * Stable error-type fingerprint of a dispatcher's result text. Returns
 * the first non-empty line trimmed and truncated to 80 chars when
 * isError; empty string otherwise. Used by the stuck-loop detector so
 * "fs_read failed with ENOENT three times" → stuck, but "fs_read
 * returned different bytes three times" → not stuck.
 */
export function extractErrorType(isError: boolean, text: string): string {
  if (!isError) return ''
  const firstNonEmpty = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstNonEmpty.trim().slice(0, 80)
}

function lastThree<T>(items: ReadonlyArray<T>): [T, T, T] | null {
  const a = items.at(-1)
  const b = items.at(-2)
  const c = items.at(-3)
  return a === undefined || b === undefined || c === undefined ? null : [a, b, c]
}

/** True iff the last 3 entries are the same tool called with identical
 *  args resulting in the identical outcome — the stuck-loop signal. */
export function isStuckLoop(
  reports: Array<Pick<ToolCallReport, 'name' | 'argsKey' | 'errorType'>>,
): boolean {
  const recent = lastThree(reports)
  if (!recent) return false
  const [a, b, c] = recent
  return a.name === b.name && b.name === c.name
    && a.argsKey === b.argsKey && b.argsKey === c.argsKey
    && a.errorType === b.errorType && b.errorType === c.errorType
}

/**
 * v1.2.122 — semantic stuck-loop: 3× DIFFERENT tool names but the same
 * salient argument value (query / URL / path / command substring).
 *
 * Catches the failure mode `isStuckLoop` misses by design:
 *   1. native_web_search(query="aapl Q3 earnings call transcript")
 *      → "0 results from duckduckgo"
 *   2. mcp__tavily(query="aapl Q3 earnings call transcript")
 *      → "0 results"
 *   3. native_exec(command="curl … aapl Q3 earnings call transcript …")
 *      → "404"
 *
 * Same intent, three different tool surfaces, all failing. The strict
 * `isStuckLoop` doesn't fire because tool NAMES differ. Without this
 * check the model keeps reshuffling tool roulette until max_iter.
 *
 * Heuristic: extract every string ≥ 8 chars from each call's argsKey
 * (a stable JSON of the call.arguments). If the SAME string appears in
 * all three recent calls AND all three tool names differ → return true.
 *
 * The ≥ 8 char floor filters out short enum-like values ("json",
 * "stop", "auto") that would false-positive across unrelated calls.
 */
export function isSemanticStuckLoop(
  reports: Array<Pick<ToolCallReport, 'name' | 'argsKey'>>,
): boolean {
  const recent = lastThree(reports)
  if (!recent) return false
  const [a, b, c] = recent
  // Need at least 2 distinct tool names; if all three are identical
  // `isStuckLoop` already covers it.
  const names = new Set([a.name, b.name, c.name])
  if (names.size < 2) return false
  // Build a candidate pool from all three calls; a candidate triggers
  // if its string appears as a substring of all three raw argsKeys.
  // Using each call's argsKey directly (not just the candidate's own
  // set) lets the matcher catch the case where the model embeds the
  // shared query inside a larger string in one of the calls — e.g.
  // {"query":"foo"} in two calls and {"command":"curl ...foo..."} in
  // the third.
  const sa = extractSalientStrings(a.argsKey)
  const sb = extractSalientStrings(b.argsKey)
  const sc = extractSalientStrings(c.argsKey)
  const candidates = new Set<string>()
  for (const s of [sa, sb, sc]) for (const v of s) candidates.add(v)
  for (const v of candidates) {
    if (a.argsKey.includes(v) && b.argsKey.includes(v) && c.argsKey.includes(v)) {
      return true
    }
  }
  return false
}

/** Pull every string at least 8 characters long out of a stable-JSON arg blob.
 *  Doesn't try to be clever about which JSON path the string came
 *  from — three calls passing the same long string anywhere in their
 *  args is already strong evidence of repeated intent. */
export function extractSalientStrings(argsKey: string): Set<string> {
  // Match any double-quoted JSON string token whose body is ≥ 8 chars
  // (post-unescape simple approximation: the matched run between
  // quotes, without escape processing). Good enough for the heuristic
  // — we only need a stable identity, not the exact decoded value.
  const out = new Set<string>()
  // Non-greedy capture, skip embedded escaped quotes via [^"\\]|\\.
  const re = /"((?:[^"\\]|\\.){8,}?)"/g
  for (let m = re.exec(argsKey); m !== null; m = re.exec(argsKey)) {
    const value = m[1]
    if (value) out.add(value)
  }
  return out
}

/** v1.2.122 — kill switch for the semantic stuck-loop check. Default ON;
 *  flip 'off' if false positives become a real problem (none observed
 *  in dogfood). */
export function resolveSemanticStuckLoopOn(): boolean {
  const raw = (process.env.AGIM_NATIVE_SEMANTIC_STUCK_LOOP ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false
  return true
}
