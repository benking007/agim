// builtin-dispatcher — safe-by-default tools the native agent can call
// without spinning up an MCP server (Stage 2 sub-PR #4).
//
// Scope of "safe":
//   - read-only or trivially-reversible
//   - no network, no filesystem mutation, no shell
//   - bounded execution time so a model loop can't burn budget here
//
// Concrete tools shipped in this initial cut:
//   * agim_echo (alias: native_echo)(text)               → return the text verbatim. Useful
//                                       for the model to confirm it heard
//                                       a piece of input, and for tests.
//   * agim_now (alias: native_now)()                    → ISO timestamp + Asia/Shanghai
//                                       offset. Honors AGIM_TZ_OFFSET_HOURS.
//   * agim_sleep_ms (alias: native_sleep_ms)(ms, ≤ 5000)     → pause for the requested ms; lets
//                                       the model deliberately yield in
//                                       tests / rate-limit shimming. Hard
//                                       capped to 5s.
//   * agim_random_uuid (alias: native_random_uuid)()            → fresh v4 UUID. Trivial but the
//                                       agent occasionally needs a stable
//                                       id without inventing one.
//
// These are intentionally tiny + boring. The whole point is for the
// native loop to have *something* to call when no MCP server is wired,
// so demos / tests / the smoke-test path all work end-to-end. Anything
// non-trivial (read_file / web_search / exec) belongs in an MCP server
// where ops can audit + sandbox properly.

import { randomUUID } from 'node:crypto'
import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'
import type { DispatcherResult, ToolDispatcher } from './tool-dispatcher.js'
import { canonicalizeToolName } from './tool-names.js'

const log = rootLogger.child({ component: 'builtin-dispatcher' })

const MAX_SLEEP_MS = 5_000

/** Definitions advertised to the LLM. Returned by `getBuiltinTools()`
 *  so callers can concat with MCP tools and pass the union to runAgentLoop. */
export function getBuiltinTools(): ToolDef[] {
  return [
    {
      name: 'agim_echo',
      description: 'Return the text argument verbatim. Useful when the model needs to confirm what it received, or to log a checkpoint.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo back.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'agim_now',
      description: 'Return the current local time as ISO 8601 plus the agim-configured timezone offset (default Asia/Shanghai, override via AGIM_TZ_OFFSET_HOURS).',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'agim_sleep_ms',
      description: 'Pause for the requested number of milliseconds (max 5000). Useful for deliberate yielding; never use to "wait for data" — call the right tool instead.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to sleep. Clamped to [0, 5000].' },
        },
        required: ['ms'],
        additionalProperties: false,
      },
    },
    {
      name: 'agim_random_uuid',
      description: 'Generate a fresh random v4 UUID.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ]
}

/** True iff `name` is one of the builtin tool names. Cheap O(1) check
 *  the dispatcher uses to decide whether to handle vs pass through. */
export function isBuiltinToolName(name: string): boolean {
  switch (canonicalizeToolName(name)) {
    case 'agim_echo':
    case 'agim_now':
    case 'agim_sleep_ms':
    case 'agim_random_uuid':
      return true
    default:
      return false
  }
}

/**
 * Build the built-in dispatcher. Returns a ToolDispatcher compatible
 * with combineDispatchers — i.e. an unknown tool name yields a
 * `{source:'unknown'}` result so the next dispatcher in the chain gets
 * a turn. Combine like this:
 *
 *     const dispatch = combineDispatchers(
 *       buildBuiltinDispatcher(),
 *       buildMcpDispatcher(),
 *     )
 */
export function buildBuiltinDispatcher(): ToolDispatcher {
  return async (call, signal) => {
    switch (canonicalizeToolName(call.name)) {
      case 'agim_echo':
        return runEcho(call.arguments)
      case 'agim_now':
        return runNow()
      case 'agim_sleep_ms':
        return runSleep(call.arguments, signal)
      case 'agim_random_uuid':
        return runRandomUuid()
      default:
        return {
          text: `unknown tool "${call.name}" (not in builtin set)`,
          isError: true,
          source: 'unknown',
        }
    }
  }
}

// ─── tool impls ──────────────────────────────────────────────────────

function runEcho(args: Record<string, unknown>): DispatcherResult {
  const text = typeof args.text === 'string' ? args.text : ''
  return { text, isError: false, source: 'builtin' }
}

function runNow(): DispatcherResult {
  const offsetHours = resolveTzOffsetHours()
  const now = new Date()
  // Build the offset string ourselves so we don't pull in a TZ DB.
  const sign = offsetHours >= 0 ? '+' : '-'
  const absHours = Math.abs(offsetHours)
  const hh = Math.floor(absHours).toString().padStart(2, '0')
  const mm = Math.round((absHours - Math.floor(absHours)) * 60).toString().padStart(2, '0')
  const offsetStr = `UTC${sign}${hh}:${mm}`
  // Apply the offset to the UTC clock to get the wall-clock string in
  // the operator's chosen zone. This is intentionally NOT a JS Date
  // mutation (which would imply a real timezone); it's just a display.
  const shifted = new Date(now.getTime() + offsetHours * 3600_000)
  const local = shifted.toISOString().replace(/Z$/, '')
  return {
    text: JSON.stringify({
      utc: now.toISOString(),
      local,
      offset: offsetStr,
    }),
    isError: false,
    source: 'builtin',
  }
}

async function runSleep(args: Record<string, unknown>, signal: AbortSignal): Promise<DispatcherResult> {
  const raw = typeof args.ms === 'number' ? args.ms : Number(args.ms)
  if (!Number.isFinite(raw)) {
    return { text: 'ms must be a number', isError: true, source: 'builtin' }
  }
  const ms = Math.max(0, Math.min(MAX_SLEEP_MS, Math.floor(raw)))
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(signal.reason ?? new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return { text: `slept ${ms}ms`, isError: false, source: 'builtin' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.debug({ event: 'builtin.sleep.aborted', err: msg })
    return { text: `sleep aborted after partial wait: ${msg}`, isError: true, source: 'builtin' }
  }
}

function runRandomUuid(): DispatcherResult {
  return { text: randomUUID(), isError: false, source: 'builtin' }
}

// ─── helpers ─────────────────────────────────────────────────────────

function resolveTzOffsetHours(): number {
  const raw = process.env.AGIM_TZ_OFFSET_HOURS
  if (raw) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= -14 && n <= 14) return n
  }
  return 8  // Asia/Shanghai default — matches the rest of agim
}
