// chat-media-api — REST surface for chat feedback, speech-to-text, and
// media upload/download. Extracted from server.ts; follows the dispatcher
// pattern used by mcp-api.ts.
//
// Endpoints:
//   PUT  /api/chat/feedback              → thumbs up/down on assistant reply  — any auth
//   GET  /api/chat/transcribe            → STT availability status            — any auth
//   POST /api/chat/transcribe            → transcribe audio blob              — any auth (rate-limited)
//   POST /api/chat/media                 → upload chat media file             — any auth
//   GET  /api/chat/media/file            → serve uploaded media file          — any auth
//   GET  /api/stt/providers              → list STT providers + status        — admin
//   GET  /api/stt/whispercpp/model       → whisper.cpp model status           — admin
//   POST /api/stt/whispercpp/model       → trigger model download             — admin

import type { IncomingMessage, ServerResponse } from 'node:http'
import { logger as rootLogger } from '../core/logger.js'
import { sessionManager } from '../core/session.js'
import {
  MAX_CHAT_MEDIA_BYTES,
  readBody,
  readBinaryBody,
  sendJson,
  sendError,
} from './http-utils.js'
import {
  requireAdmin,
  isRequestAdmin,
  extractToken,
  verifyTokenSync,
} from './auth.js'

const webLog = rootLogger.child({ component: 'web' })

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleChatMediaApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/chat/feedback' && m === 'PUT') {
    await handleChatFeedback(req, res); return true
  }
  if (p === '/api/chat/transcribe' && m === 'GET') {
    await handleChatTranscribeStatus(req, res); return true
  }
  if (p === '/api/chat/transcribe' && m === 'POST') {
    await handleChatTranscribe(req, res, url); return true
  }
  if (p === '/api/chat/media' && m === 'POST') {
    await handleChatMediaUpload(req, res, url); return true
  }
  if (p === '/api/chat/media/file' && m === 'GET') {
    await handleChatMediaFile(req, res, url); return true
  }
  if (p === '/api/stt/providers' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleSttProviders(req, res); return true
  }
  if (p === '/api/stt/whispercpp/model' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleSttWhisperModelGet(req, res); return true
  }
  if (p === '/api/stt/whispercpp/model' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleSttWhisperModelInit(req, res); return true
  }
  return false
}

async function handleChatFeedback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const {
    upsertMessageFeedback,
  } = await import('../core/message-feedback.js')
  const {
    clearPendingDownvoteHint,
    feedbackThreadKey,
    setPendingDownvoteHint,
  } = await import('../core/message-feedback-hints.js')
  const { recordMessageFeedback } = await import('../core/metrics.js')

  let body: string
  try {
    body = await readBody(req, res)
  } catch (err) {
    if ((err as { handled?: boolean }).handled) return
    sendError(res, 400, 'BAD_BODY', { message: 'failed to read body' })
    return
  }
  let parsed: {
    threadId?: string
    messageId?: string
    messageIndex?: number
    vote?: string | null
  }
  try {
    parsed = JSON.parse(body || '{}') as typeof parsed
  } catch {
    sendError(res, 400, 'BAD_JSON', { message: 'invalid JSON' })
    return
  }

  const threadId = typeof parsed.threadId === 'string' ? parsed.threadId.trim().slice(0, 120) : ''
  if (!threadId || !/^web-[A-Za-z0-9_-]{4,64}$/.test(threadId)) {
    sendError(res, 400, 'THREAD_ID_INVALID', { message: 'threadId required (web-* form)' })
    return
  }

  let vote: 'up' | 'down' | null
  if (parsed.vote === null || parsed.vote === undefined || parsed.vote === '') {
    vote = null
  } else if (parsed.vote === 'up' || parsed.vote === 'down') {
    vote = parsed.vote
  } else {
    sendError(res, 400, 'VOTE_INVALID', { message: 'vote must be up, down, or null' })
    return
  }

  const history = await sessionManager.getSessionWithHistory('web', 'web', threadId)
  if (!history || history.messages.length === 0) {
    sendError(res, 404, 'SESSION_NOT_FOUND', { message: 'no chat history for thread' })
    return
  }

  const messageId = typeof parsed.messageId === 'string' && parsed.messageId.trim()
    ? parsed.messageId.trim().slice(0, 80)
    : undefined
  let messageIndex = typeof parsed.messageIndex === 'number' && Number.isInteger(parsed.messageIndex)
    ? parsed.messageIndex
    : -1

  if (messageId) {
    const byId = history.messages.findIndex((m) => m.id === messageId)
    if (byId >= 0) messageIndex = byId
  }
  if (messageIndex < 0 || messageIndex >= history.messages.length) {
    // Live bubble before HISTORY remap: allow targeting the latest assistant.
    if (messageId || parsed.messageIndex === undefined) {
      for (let i = history.messages.length - 1; i >= 0; i--) {
        if (history.messages[i]?.role === 'assistant') {
          messageIndex = i
          break
        }
      }
    }
  }
  if (messageIndex < 0 || messageIndex >= history.messages.length) {
    sendError(res, 404, 'MESSAGE_NOT_FOUND', { message: 'assistant message not found' })
    return
  }

  const target = history.messages[messageIndex]
  if (!target || target.role !== 'assistant') {
    sendError(res, 400, 'NOT_ASSISTANT', { message: 'feedback only applies to assistant messages' })
    return
  }

  const resolvedId = messageId || target.id
  const result = await upsertMessageFeedback({
    platform: 'web',
    channelId: 'web',
    threadId,
    messageIndex,
    messageId: resolvedId,
    vote,
  })

  const hintKey = feedbackThreadKey('web', 'web', threadId)
  if (result.vote === 'down') setPendingDownvoteHint(hintKey)
  else clearPendingDownvoteHint(hintKey)

  if (result.vote === 'up' || result.vote === 'down') {
    recordMessageFeedback(result.vote)
  }

  sendJson(res, 200, {
    ok: true,
    vote: result.vote,
    messageIndex,
    messageId: resolvedId || null,
  })
}

async function handleChatTranscribeStatus(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { isTranscribeConfigured } = await import('../core/chat-transcribe.js')
  const { detectProvider, listTranscribeProviders } = await import('../core/transcribe.js')
  const listed = listTranscribeProviders()
  sendJson(res, 200, {
    configured: isTranscribeConfigured(),
    provider: detectProvider(),
    active: listed.active,
    explicit: listed.explicit,
    providers: listed.providers,
  })
}

async function handleSttProviders(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const { listTranscribeProviders } = await import('../core/transcribe.js')
    sendJson(res, 200, listTranscribeProviders())
  } catch (err) {
    sendError(res, 500, 'STT_PROVIDERS_FAILED', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleSttWhisperModelGet(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const { getWhisperModelStatus } = await import('../core/transcribe-whispercpp-resolve.js')
    sendJson(res, 200, getWhisperModelStatus())
  } catch (err) {
    sendError(res, 500, 'STT_WHISPER_MODEL_STATUS_FAILED', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** POST /api/stt/whispercpp/model — kick off ggml-base.bin download (or no-op if ready). */
async function handleSttWhisperModelInit(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const {
      getWhisperModelStatus,
      startWhisperModelDownload,
    } = await import('../core/transcribe-whispercpp-resolve.js')
    const result = startWhisperModelDownload()
    const status = getWhisperModelStatus()
    if (result.alreadyReady) {
      sendJson(res, 200, { ok: true, ...result, ...status })
      return
    }
    // 202 — download running in background; SPA polls GET / status via providers.
    sendJson(res, 202, { ok: true, ...result, ...status })
  } catch (err) {
    sendError(res, 500, 'STT_WHISPER_MODEL_INIT_FAILED', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Per-actor STT rate limit (token id or peer IP). Env: AGIM_STT_MAX_PER_MIN (default 20). */
const sttRateWindow = new Map<string, { count: number; resetAt: number }>()
let sttInFlight = 0
const STT_MAX_IN_FLIGHT = (() => {
  const n = Number(process.env.AGIM_STT_MAX_IN_FLIGHT)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4
})()

function consumeSttRateLimit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const max = (() => {
    const n = Number(process.env.AGIM_STT_MAX_PER_MIN)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20
  })()
  const now = Date.now()
  let slot = sttRateWindow.get(key)
  if (!slot || slot.resetAt <= now) {
    slot = { count: 0, resetAt: now + 60_000 }
    sttRateWindow.set(key, slot)
  }
  if (slot.count >= max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((slot.resetAt - now) / 1000)) }
  }
  slot.count++
  // Opportunistic prune of stale windows
  if (sttRateWindow.size > 2000) {
    for (const [k, v] of sttRateWindow) {
      if (v.resetAt <= now) sttRateWindow.delete(k)
    }
  }
  return { ok: true }
}

async function handleChatTranscribe(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const {
    CHAT_TRANSCRIBE_MAX_BYTES,
    isTranscribeConfigured,
    transcribeChatAudio,
  } = await import('../core/chat-transcribe.js')
  const { TranscribeError } = await import('../core/transcribe.js')
  if (!isTranscribeConfigured()) {
    sendError(res, 503, 'STT_NOT_CONFIGURED', {
      message: 'Speech-to-text is not configured. Open /settings/stt and set AGIM_STT_* vendor keys (or whisper.cpp).',
    })
    return
  }
  const tok = extractToken(req, url)
  const actor = (tok && verifyTokenSync(tok)) || req.socket.remoteAddress || 'anon'
  const rate = consumeSttRateLimit(actor)
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfterSec))
    sendError(res, 429, 'STT_RATE_LIMIT', {
      message: `Too many transcription requests; retry in ${rate.retryAfterSec}s`,
    })
    return
  }
  if (sttInFlight >= STT_MAX_IN_FLIGHT) {
    sendError(res, 429, 'STT_BUSY', {
      message: 'Transcription server busy; retry shortly',
    })
    return
  }
  sttInFlight++
  const filenameHeader = req.headers['x-agim-filename']
  const mimeHeader = req.headers['x-agim-mime']
  const langHeader = req.headers['x-agim-language']
  const filenameRaw = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader
  const mime = Array.isArray(mimeHeader) ? mimeHeader[0] : mimeHeader
  const language = Array.isArray(langHeader) ? langHeader[0] : langHeader
  let filename = filenameRaw
  if (filename) {
    try { filename = decodeURIComponent(filename) } catch { /* keep raw */ }
  }
  try {
    const body = await readBinaryBody(req, res, CHAT_TRANSCRIBE_MAX_BYTES)
    const result = await transcribeChatAudio({
      body,
      mime: mime || undefined,
      filename: filename || undefined,
      language: language || 'zh',
    })
    const text = (result.text || '').trim()
    if (!text) {
      sendError(res, 422, 'STT_EMPTY', { message: 'No speech detected' })
      return
    }
    sendJson(res, 200, {
      text,
      provider: result.provider,
      elapsedMs: result.elapsedMs,
    })
  } catch (err) {
    const e = err as Error & { code?: string; handled?: boolean; reason?: string; provider?: string }
    if (e.handled) return
    if (e.code === 'TOO_LARGE') {
      sendError(res, 413, 'STT_TOO_LARGE', {
        message: e.message,
        extra: { maxBytes: CHAT_TRANSCRIBE_MAX_BYTES },
      })
      return
    }
    if (err instanceof TranscribeError || e.name === 'TranscribeError') {
      const reason = e.reason || e.message
      const reasonText = String(reason)
      // Credential / path missing — guide operators to Settings, not raw env names.
      if (
        reasonText.includes('no STT provider configured')
        || reasonText.includes('no provider')
        || reasonText.includes('not configured')
        || /AGIM_STT_\w+ not set/.test(reasonText)
      ) {
        sendError(res, 503, 'STT_NOT_CONFIGURED', {
          message: reasonText.includes('/settings/stt')
            ? reasonText
            : 'Speech-to-text is not configured. Open /settings/stt and set a cloud vendor (or host whisper.cpp paths).',
        })
        return
      }
      webLog.warn({ err: e, provider: e.provider }, 'chat transcribe failed')
      sendError(res, 502, 'STT_FAILED', { message: reason || 'transcription failed' })
      return
    }
    webLog.warn({ err: e }, 'chat transcribe failed')
    sendError(res, 500, 'STT_FAILED', { message: e.message || 'transcription failed' })
  } finally {
    sttInFlight = Math.max(0, sttInFlight - 1)
  }
}

async function handleChatMediaUpload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const { formatMediaMarker, saveWebChatMedia, WEB_MEDIA_MAX_BYTES } = await import('../core/web-media-upload.js')
  const filenameHeader = req.headers['x-agim-filename']
  const mimeHeader = req.headers['x-agim-mime']
  const filenameRaw = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader
  const mime = Array.isArray(mimeHeader) ? mimeHeader[0] : mimeHeader
  let filename = filenameRaw
  if (filename) {
    try { filename = decodeURIComponent(filename) } catch { /* keep raw */ }
  }
  if (!filename) {
    sendError(res, 400, 'MEDIA_FILENAME_REQUIRED', { message: 'X-Agim-Filename required' })
    return
  }
  const threadId = (url.searchParams.get('threadId') || 'web').slice(0, 120)
  try {
    const body = await readBinaryBody(req, res, Math.max(WEB_MEDIA_MAX_BYTES, MAX_CHAT_MEDIA_BYTES))
    const saved = await saveWebChatMedia({
      threadId,
      filename,
      mime: mime || 'application/octet-stream',
      body,
    })
    sendJson(res, 200, {
      path: saved.path,
      bytes: saved.bytes,
      mime: saved.mime,
      name: saved.name,
      kind: saved.kind,
      marker: formatMediaMarker(saved),
    })
  } catch (err) {
    const e = err as Error & { code?: string; handled?: boolean }
    if (e.handled) return
    if (e.code === 'TOO_LARGE') {
      sendError(res, 413, 'MEDIA_TOO_LARGE', { message: e.message })
      return
    }
    if (e.code === 'EMPTY') {
      sendError(res, 400, 'MEDIA_EMPTY', { message: e.message })
      return
    }
    webLog.warn({ err: e }, 'chat media upload failed')
    sendError(res, 500, 'MEDIA_UPLOAD_FAILED', { message: e.message || 'upload failed' })
  }
}

async function handleChatMediaFile(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const {
    guessMediaContentType,
    resolveSafeWebMediaPath,
  } = await import('../core/web-media-upload.js')
  const raw = url.searchParams.get('path') || ''
  // role=user must scope media to their thread; admins may read any
  // path under the media root (realpath-checked).
  const threadId = (url.searchParams.get('threadId') || '').trim()
  if (!isRequestAdmin(req)) {
    if (!threadId) {
      sendError(res, 400, 'MEDIA_PATH_INVALID', { message: 'threadId query param required' })
      return
    }
    const tok = extractToken(req, url)
    const tokenId = tok ? verifyTokenSync(tok) : null
    if (!tokenId) {
      sendError(res, 401, 'AUTH_REQUIRED', { message: 'authentication required' })
      return
    }
    const { webThreadOwners } = await import('../core/web-thread-owners.js')
    const owner = webThreadOwners.get(threadId)
    if (owner !== undefined && owner !== tokenId) {
      sendError(res, 403, 'MEDIA_FORBIDDEN', { message: 'thread not owned by this session' })
      return
    }
  }
  const abs = isRequestAdmin(req)
    ? resolveSafeWebMediaPath(raw)
    : resolveSafeWebMediaPath(raw, { threadId })
  if (!abs) {
    sendError(res, 400, 'MEDIA_PATH_INVALID', { message: 'invalid media path' })
    return
  }
  try {
    const { promises: fs } = await import('node:fs')
    const st = await fs.stat(abs)
    if (!st.isFile()) {
      sendError(res, 404, 'MEDIA_NOT_FOUND', { message: 'media not found' })
      return
    }
    const buf = await fs.readFile(abs)
    const name = abs.split(/[/\\]/).pop() || 'file'
    const contentType = guessMediaContentType(name)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': buf.length,
      'Content-Disposition': `inline; filename="${name.replace(/"/g, '_')}"`,
      'Cache-Control': 'private, max-age=3600',
    })
    res.end(buf)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      sendError(res, 404, 'MEDIA_NOT_FOUND', { message: 'media not found' })
      return
    }
    webLog.warn({ err }, 'chat media file read failed')
    sendError(res, 500, 'MEDIA_READ_FAILED', {
      message: err instanceof Error ? err.message : 'read failed',
    })
  }
}
