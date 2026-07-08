// loop-guards — shared reliability primitives for agent loops.
//
// Both runAgentLoop (agent-loop.ts) and pi-native's AgentHarness path
// consume these guards so detection algorithms stay aligned and
// improvements propagate to both paths automatically.

// ─── env helpers ─────────────────────────────────────────────────────

/** Resolve a boolean env var with a default. Lightweight: just a string
 *  compare per call — no caching needed since callers should hoist
 *  the result to the top of their loop/turn scope. */
export function resolveEnvBool(key: string, defaultValue: boolean): boolean {
  const raw = (process.env[key] ?? '').toLowerCase().trim()
  if (!raw) return defaultValue
  return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no' || raw === 'disable')
}

/** Resolve an integer env var with a default and optional clamp. */
export function resolveEnvInt(
  key: string,
  defaultValue: number,
  opts?: { min?: number; max?: number },
): number {
  const raw = (process.env[key] ?? '').trim()
  let result = defaultValue
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) result = n
  }
  if (opts?.min !== undefined) result = Math.max(opts.min, result)
  if (opts?.max !== undefined) result = Math.min(opts.max, result)
  return result
}

// ─── stableStringify ─────────────────────────────────────────────────

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

// ─── error type fingerprint ──────────────────────────────────────────

/**
 * Stable error-type fingerprint of a dispatcher's result text. Returns
 * the first non-empty line trimmed and truncated to 80 chars when
 * isError; empty string otherwise.
 */
export function extractErrorType(isError: boolean, text: string): string {
  if (!isError) return ''
  const firstNonEmpty = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstNonEmpty.trim().slice(0, 80)
}

// ─── stuck-loop detection ────────────────────────────────────────────

export interface ToolCallFingerprint {
  name: string
  argsKey: string
  errorType: string
}

/** True iff the last 3 entries are the same tool called with identical
 *  args resulting in the identical outcome — the stuck-loop signal. */
export function isStuckLoop(
  reports: ArrayLike<Pick<ToolCallFingerprint, 'name' | 'argsKey' | 'errorType'>>,
): boolean {
  const len = reports.length
  if (len < 3) return false
  const a = reports[len - 1]!
  const b = reports[len - 2]!
  const c = reports[len - 3]!
  return a.name === b.name && b.name === c.name
    && a.argsKey === b.argsKey && b.argsKey === c.argsKey
    && a.errorType === b.errorType && b.errorType === c.errorType
}

// ─── semantic stuck-loop detection ───────────────────────────────────

/** Pull every string >= 8 chars out of a stable-JSON arg blob. */
export function extractSalientStrings(argsKey: string): Set<string> {
  const out = new Set<string>()
  const re = /"((?:[^"\\]|\\.){8,}?)"/g
  for (let m = re.exec(argsKey); m !== null; m = re.exec(argsKey)) {
    out.add(m[1]!)
  }
  return out
}

/**
 * Semantic stuck-loop: 3 DIFFERENT tool names but the same salient
 * argument value. Catches the failure mode where the model tries
 * Tavily -> DDG -> Brave (or read_file -> cat -> less) with the same
 * query/path.
 */
export function isSemanticStuckLoop(
  reports: ArrayLike<Pick<ToolCallFingerprint, 'name' | 'argsKey'>>,
): boolean {
  const len = reports.length
  if (len < 3) return false
  const a = reports[len - 1]!
  const b = reports[len - 2]!
  const c = reports[len - 3]!
  const names = new Set([a.name, b.name, c.name])
  if (names.size < 2) return false
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

// ─── LoopGuard: composable tracker for both loop paths ───────────────

export interface LoopGuardReport {
  name: string
  isError: boolean
  argsKey: string
  errorType: string
}

export interface LoopGuardConfig {
  semanticStuckLoopEnabled?: boolean
}

/**
 * Stateful guard that tracks tool calls and detects stuck/semantic-stuck
 * patterns. Instantiate once per turn; feed it tool call results in order.
 *
 * Used by both agent-loop.ts (via ToolCallReport) and pi-native (via
 * tool_result events).
 */
export class LoopGuard {
  private readonly reports: LoopGuardReport[] = []
  private readonly semanticEnabled: boolean

  constructor(cfg: LoopGuardConfig = {}) {
    this.semanticEnabled = cfg.semanticStuckLoopEnabled ??
      resolveEnvBool('AGIM_NATIVE_SEMANTIC_STUCK_LOOP', true)
  }

  /** Record a completed tool call and return whether the loop should
   *  terminate due to a stuck pattern. */
  record(report: LoopGuardReport): { stuck: boolean; semantic: boolean } {
    this.reports.push(report)
    const stuck = isStuckLoop(this.reports)
    const semantic = !stuck && this.semanticEnabled && isSemanticStuckLoop(this.reports)
    return { stuck, semantic: semantic || false }
  }

  /** Build a LoopGuardReport from raw tool-result data. Handles the
   *  stable-stringify + error-type extraction. */
  static buildReport(
    name: string,
    input: unknown,
    isError: boolean,
    resultText: string,
  ): LoopGuardReport {
    return {
      name,
      isError,
      argsKey: stableStringify(input),
      errorType: extractErrorType(isError, resultText),
    }
  }

  /** Access the tracked reports (readonly). */
  get tracked(): readonly LoopGuardReport[] {
    return this.reports
  }

  get lastThree(): readonly LoopGuardReport[] {
    return this.reports.slice(-3)
  }
}
