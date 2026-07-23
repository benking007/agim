// http-utils — shared HTTP helpers for the web REST API.
// Kept in a standalone module so handler files can import without
// pulling in the full server.ts dependency graph.

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Hard cap on inbound JSON bodies for the Web REST API. */
export const MAX_API_BODY_BYTES = 1 * 1024 * 1024  // 1 MiB
/** Binary chat media (images/files) — keep in sync with WEB_MEDIA_MAX_BYTES. */
export const MAX_CHAT_MEDIA_BYTES = 20 * 1024 * 1024

export function readBody(req: IncomingMessage, res?: ServerResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > MAX_API_BODY_BYTES) {
        aborted = true
        if (res && !res.headersSent) {
          sendJson(res, 413, { error: 'Request body too large' })
          res.once('finish', () => {
            if (!req.destroyed) req.destroy()
          })
        } else if (!req.destroyed) {
          req.destroy()
        }
        const err = new Error('Request body too large') as Error & { statusCode?: number; handled?: boolean }
        err.statusCode = 413
        err.handled = !!res
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

export function readBinaryBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > maxBytes) {
        aborted = true
        if (!res.headersSent) {
          sendJson(res, 413, { error: 'file too large', code: 'MEDIA_TOO_LARGE', maxBytes })
          res.once('finish', () => {
            if (!req.destroyed) req.destroy()
          })
        } else if (!req.destroyed) {
          req.destroy()
        }
        const err = new Error('file too large') as Error & { handled?: boolean }
        err.handled = true
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Send a machine-readable error response. The SPA's `lib/api/client.ts`
 * reads `body.code` and maps it through `errors.json` → user-facing text;
 * the legacy `error` string remains as a fallback for tools that don't
 * speak the code dictionary (curl, older clients, tests grepping the
 * response).
 *
 * Convention: codes are UPPER_SNAKE, namespaced by feature when needed
 * (e.g. `EMAIL_NOT_CONFIGURED`, `MEMORY_USER_KEY_REQUIRED`). Bare names
 * like `VALIDATION` / `NOT_FOUND` cover broad buckets. Add new entries
 * to `src/web-app/src/i18n/locales/{en,zh}/errors.json` together with
 * the call site so the SPA picks up the human text.
 *
 * Use `detail` when the human message has variable parts the SPA can
 * interpolate (`{{detail}}` in the i18n template). Use `message` when
 * you want a fully-formed line that's safe to surface verbatim (the
 * SPA fallback path renders this when no per-code key exists).
 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  options?: { message?: string; detail?: string; extra?: Record<string, unknown> },
): void {
  const message = options?.message ?? options?.detail ?? code
  const body: Record<string, unknown> = { error: message, code }
  if (options?.detail !== undefined) body.detail = options.detail
  if (options?.extra) Object.assign(body, options.extra)
  sendJson(res, status, body)
}
