// agent-loop-config — env resolver functions and compile-time constants.
// Extracted from agent-loop.ts; agent-loop.ts is now a re-export facade.

export const DEFAULT_MAX_ITERATIONS = 20
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000  // 5 min — generous; signal usually fires first

// v1.2.98 — goal-critic firing schedule. Thresholds chosen empirically:
// fewer than 5 tool calls = not enough trail to judge; more often than
// every 5 tool calls = critic itself becomes too noisy. Per-turn cap
// of 2 keeps a runaway critic from compounding cost on a hot turn.
export const CRITIC_MIN_TOOL_CALLS = 5
export const CRITIC_EVERY_N = 5
export const CRITIC_MAX_CALLS = 2

/** v1.2.110 — gate the tool-args schema validator. Default ON; ops can
 *  flip OFF via env if a vendor schema confuses the lightweight
 *  validator (e.g. uses $ref / oneOf which we don't implement). The
 *  escape hatch keeps a footgun small. */
export function resolveSchemaValidate(): boolean {
  const raw = (process.env.AGIM_TOOL_SCHEMA_VALIDATE ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false
  return true
}

/** v1.2.112 — process-wide kill switch for the streaming code path.
 *  When 'off', `streamPartialText: true` requests are silently
 *  downgraded to buffered `chat()`. Default 'on' (i.e. honour caller
 *  opt-in). Operators flip 'off' if a vendor's streaming endpoint
 *  misbehaves and they don't want to redeploy. */
export function resolveStreamEnabled(): boolean {
  const raw = (process.env.AGIM_AGENT_LOOP_STREAM ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false
  return true
}

/** v1.2.117 — max times the loop will auto-continue on
 *  `finish_reason === 'length'` within a single user turn. Capped at 3
 *  to mirror HKUDS/nanobot's runner.py and prevent obot's documented
 *  "$0.91 burned on 6 consecutive length retries" disaster. Set 0 to
 *  disable auto-continue entirely (loop will just return partial text
 *  with finishReason='length' as it did pre-1.2.117). */
const DEFAULT_LENGTH_RECOVERY_MAX = 3
export function resolveLengthRecoveryMax(): number {
  const raw = (process.env.AGIM_NATIVE_LENGTH_RECOVERY_MAX ?? '').trim()
  if (!raw) return DEFAULT_LENGTH_RECOVERY_MAX
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LENGTH_RECOVERY_MAX
  return Math.min(n, 10)
}

/** v1.2.118 — cap each tool's result text length. A single 5 MB grep /
 *  curl can poison context for the rest of the turn (and silently
 *  reach the model's input limit before auto-compact kicks in). Default
 *  32768 chars (~8 KB tokens). Env override or 0 to disable. */
const DEFAULT_TOOL_RESULT_MAX_CHARS = 32_768
export function resolveToolResultMaxChars(): number {
  const raw = (process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS ?? '').trim()
  if (!raw) return DEFAULT_TOOL_RESULT_MAX_CHARS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TOOL_RESULT_MAX_CHARS
  return n
}

/** v1.2.118 — per-tool wall timeout. Independent from the loop's overall
 *  timeoutMs (which covers the whole turn) and from web-dispatcher's
 *  own internal timeout (which covers only HTTP calls). This catches a
 *  runaway tool that doesn't respect its own signal — e.g. a wedged
 *  `native_exec` subprocess on a corner case. Default 60s; 0 disables. */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
export function resolveToolTimeoutMs(perToolMs: number | undefined): number {
  if (typeof perToolMs === 'number' && perToolMs >= 0) return perToolMs
  const raw = (process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS ?? '').trim()
  if (!raw) return DEFAULT_TOOL_TIMEOUT_MS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TOOL_TIMEOUT_MS
  return n
}

/** Outer wall for one dispatch. Honors ToolDef.timeoutMs / env, then
 *  raises it to the call's `timeout_ms` so agim_exec(timeout_ms: 300000)
 *  is not killed by the generic 60s tool-bridge cap. `0` still means
 *  "no outer cap" (A2A / ask_user). */
export function resolveDispatchTimeoutMs(
  perToolMs: number | undefined,
  args?: Record<string, unknown>,
): number {
  const base = resolveToolTimeoutMs(perToolMs)
  if (!args || base <= 0) return base
  const raw = args.timeout_ms ?? args.timeoutMs
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return base
  return Math.max(base, Math.floor(n))
}

/** v1.2.119 — intra-loop blank-response retry cap. Complements v1.2.94's
 *  POST-loop auto-summary (which only fires when tools ran). This handles
 *  the case where the provider returns `finishReason: 'stop'` with
 *  empty text AND no tool_calls *inside* the loop — usually a transient
 *  brain-fart that resolves with a single nudge. Default 2 (nanobot's
 *  `_MAX_EMPTY_RETRIES`). 0 disables. */
const DEFAULT_BLANK_RETRY_MAX = 2
export function resolveBlankRetryMax(): number {
  const raw = (process.env.AGIM_NATIVE_BLANK_RETRY_MAX ?? '').trim()
  if (!raw) return DEFAULT_BLANK_RETRY_MAX
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_BLANK_RETRY_MAX
  return Math.min(n, 5)
}

export function resolveFirstTokenRetryMax(): number {
  const raw = (process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX ?? '').trim()
  if (!raw) return 1
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 1
  return Math.min(n, 3)  // hard cap — operators don't usually want >3 retries
}

export function resolveFirstTokenRetryDelayMs(): number {
  const raw = (process.env.AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS ?? '').trim()
  if (!raw) return 1000
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 1000
  return Math.min(n, 10000)  // cap at 10s — beyond that IM 30-min budget hurts
}

/** Synthetic user nudge for the blank-response branch. Short + explicit
 *  so the model gets that it produced nothing the user can see. */
export const BLANK_RESPONSE_NUDGE =
  'Your last response was empty (no text and no tool call). ' +
  'Please continue: either call a tool to make progress, or produce ' +
  'a complete answer to the user. If you have already completed the ' +
  'task, write the closing summary now.'

/** v1.2.117 — synthetic user message we inject after a `length` truncation.
 *  Kept short (cache-friendly) and explicit ("don't repeat") so the model
 *  picks up exactly where it stopped rather than re-summarising. */
export const LENGTH_RECOVERY_MESSAGE =
  'Your previous response was cut off due to the output length limit. ' +
  'Continue from exactly where you left off — do not repeat any content ' +
  'and do not start over. If you were inside a markdown list, table, or ' +
  'code block, continue inside it; if you were mid-sentence, complete it.'
