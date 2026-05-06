// Structured logging with trace id support

import pino from 'pino'
import { randomUUID } from 'crypto'

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
      'headers["x-im-hub-token"]',
    ],
    censor: '[REDACTED]',
  },
})

export function generateTraceId(): string {
  // 16 hex chars (≈ 2^64). 12 hex (≈ 2^48) collides ~once per 16M ids on
  // average — visible at sustained > 1 K req/s. 16 hex pushes the
  // expectation past the realistic lifetime of any single im-hub process
  // without burning much log volume (4 extra chars per line).
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

export function createLogger(bindings: Record<string, unknown> = {}): pino.Logger {
  return root.child(bindings)
}

export { root as logger }
