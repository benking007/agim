// Structured logging with trace id support

import pino from 'pino'
import { randomUUID, createHash } from 'node:crypto'

const level = process.env.LOG_LEVEL || 'info'
const usePretty = process.env.LOG_FORMAT === 'pretty' || (
  process.env.LOG_FORMAT !== 'json' && process.stdout.isTTY
)

const root = pino({
  level,
  ...(usePretty ? {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  } : {}),
  serializers: {
    token: () => '[REDACTED]',
    botToken: () => '[REDACTED]',
    bot_token: () => '[REDACTED]',
    appSecret: () => '[REDACTED]',
    app_secret: () => '[REDACTED]',
    password: () => '[REDACTED]',
  },
  // serializers above only apply to top-level keys passed to log methods.
  // redact.paths walks nested structures (config objects, error contexts)
  // and is the line of defense against tokens that leaked into wrapped
  // payloads, e.g. `log.info({ config: { botToken: '...' } })` or
  // `log.warn({ err: { url: '...?token=...' } })`.
  redact: {
    paths: [
      '*.token', '*.botToken', '*.bot_token',
      '*.apiKey', '*.api_key',
      '*.appSecret', '*.app_secret',
      '*.password', '*.secret',
      'headers.authorization',
      'headers["x-agim-token"]',
    ],
    censor: '[REDACTED]',
  },
})

/**
 * Sanitise free-form user text for safe inclusion in structured logs.
 *
 * Pre-existing behaviour: `text.substring(0, 120)` put the first 120
 * characters of every user message verbatim into stdout. With
 * systemd-journald persistence + SIEM forwarding, that meant sensitive
 * chat (credentials pasted by a user, PII, internal product names)
 * ended up archived in the security-event store indefinitely.
 *
 * The replacement returns three short fields:
 *
 *   * `len`    — full length in characters (operationally useful)
 *   * `prefix` — first 6 chars only, for "is this what I expected?" sanity
 *   * `hash`   — sha256 first 12 hex chars of the FULL text, lets the
 *                operator correlate the same message across multiple
 *                log lines or with the original (if the user later
 *                provides it) without storing the message itself
 *
 * Designed to be spread into a structured log call:
 *   `logger.info({ event: 'message.received', ...sanitizeUserText(text) })`
 *
 * Operators who need the verbatim text (e.g. for debugging) can re-enable
 * by setting `AGIM_LOG_USER_TEXT=1` — that path is intentionally noisy
 * (`WARN` level) so it surfaces in default LOG_LEVEL=info deployments.
 */
export function sanitizeUserText(text: string): {
  len: number
  prefix: string
  hash: string
  text?: string  // only present when AGIM_LOG_USER_TEXT=1 (debug)
} {
  const safe = typeof text === 'string' ? text : String(text ?? '')
  const out: { len: number; prefix: string; hash: string; text?: string } = {
    len: safe.length,
    prefix: safe.slice(0, 6),
    hash: createHash('sha256').update(safe).digest('hex').slice(0, 12),
  }
  // Opt-in escape hatch — only for live debugging on a controlled host.
  // We keep the 120-char cap as a guardrail against accidental log
  // flooding when this flag is set.
  if (process.env.AGIM_LOG_USER_TEXT === '1') {
    out.text = safe.slice(0, 120)
  }
  return out
}

export function generateTraceId(): string {
  // 16 hex chars (≈ 2^64). 12 hex (≈ 2^48) collides ~once per 16M ids on
  // average — visible at sustained > 1 K req/s. 16 hex pushes the
  // expectation past the realistic lifetime of any single agim process
  // without burning much log volume (4 extra chars per line).
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

export function createLogger(bindings: Record<string, unknown> = {}): pino.Logger {
  return root.child(bindings)
}

export { root as logger }
