// messengers-api — WeChat QR login, IM admin allowlist, notify, invoke, email test.
// Extracted from server.ts; follows the dispatcher pattern used by config-api.ts.
//
// Endpoints:
//   POST /api/messengers/wechat/qr-start    → start WeChat QR scan         — admin only
//   GET  /api/messengers/wechat/qr-status   → poll QR scan result          — admin only
//   GET  /api/admin-allowlist               → list IM admins               — admin only
//   POST /api/admin-allowlist               → add IM admin                  — admin only
//   DELETE /api/admin-allowlist             → remove IM admin               — admin only
//   POST /api/messengers/email/test         → verify SMTP credentials       — admin only
//   POST /api/notify                        → push message to IM thread     — admin only
//   POST /api/invoke                        → run agent prompt              — admin only

import type { IncomingMessage, ServerResponse } from 'node:http'
import { updateConfigObject } from '../core/config-store.js'
import { generateTraceId, createLogger } from '../core/logger.js'
import { sink, resolveMessenger } from '../core/message-sink.js'
import { parseMessage, routeMessage } from '../core/router.js'
import { readBody, sendJson, sendError } from './http-utils.js'
import { requireAdmin, getRequestActor, getRequestUserId } from './auth.js'

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 *
 * Note: `handleInvoke` needs `defaultAgent` — callers may pass it as
 * the fourth argument; otherwise the process default is used.
 */
export async function handleMessengersApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  defaultAgent?: string,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/messengers/wechat/qr-start' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleWechatQrStart(res); return true
  }
  if (p === '/api/messengers/wechat/qr-status' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleWechatQrStatus(req, res, url); return true
  }
  if (p === '/api/admin-allowlist' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleAdminAllowlistGet(res); return true
  }
  if (p === '/api/admin-allowlist' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleAdminAllowlistAdd(req, res); return true
  }
  if (p === '/api/admin-allowlist' && m === 'DELETE') {
    if (!requireAdmin(req, res)) return true
    await handleAdminAllowlistRemove(req, res); return true
  }
  if (p === '/api/messengers/email/test' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleEmailTest(req, res); return true
  }
  if (p === '/api/notify' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleNotify(req, res); return true
  }
  if (p === '/api/invoke' && m === 'POST') {
    if (!requireAdmin(req, res)) return true
    await handleInvoke(req, res, defaultAgent ?? 'agim'); return true
  }
  return false
}

export async function handleWechatQrStart(res: ServerResponse): Promise<void> {
  try {
    const { ILinkWeChatAdapter } = await import('../plugins/messengers/wechat/ilink-adapter.js')
    const adapter = new ILinkWeChatAdapter()
    const { qrUrl, qrToken } = await adapter.startQRLogin()
    const QRCode = (await import('qrcode')).default
    const qrImage = await QRCode.toDataURL(qrUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
    })
    sendJson(res, 200, { qrUrl, qrToken, qrImage })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

export async function handleWechatQrStatus(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const qrToken = url.searchParams.get('token') || ''
  if (!qrToken) {
    sendJson(res, 400, { error: 'token query param required' })
    return
  }
  try {
    const { ILinkWeChatAdapter } = await import('../plugins/messengers/wechat/ilink-adapter.js')
    const adapter = new ILinkWeChatAdapter()
    const result = await adapter.pollQRLogin(qrToken)
    if (result.status === 'confirmed') {
      try {
        await updateConfigObject((current) => {
          const messengers = Array.isArray(current.messengers)
            ? current.messengers.filter((item): item is string => typeof item === 'string')
            : []
          return {
            config: messengers.includes('wechat-ilink')
              ? current
              : { ...current, messengers: [...messengers, 'wechat-ilink'] },
            result: undefined,
          }
        }, {
          fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
        })
      } catch { /* best-effort */ }
      const actorUserId = getRequestUserId(req)
      const scanned = result.credentials?.userId
      if (actorUserId) {
        try {
          const { claimImIdentity, claimMessengerPlatform } = await import('../core/im-bind.js')
          claimMessengerPlatform('wechat', actorUserId)
          if (scanned) {
            claimImIdentity({ platform: 'wechat', imUserId: scanned, userId: actorUserId })
          }
        } catch { /* key stamp is best-effort; QR confirm already succeeded */ }
      }
    }
    sendJson(res, 200, result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendJson(res, 500, { error: msg })
  }
}

export async function handleAdminAllowlistGet(res: ServerResponse): Promise<void> {
  try {
    const {
      listAdmins,
      listKnownImUsers,
      isAllowlistConfigured,
    } = await import('../core/admin-allowlist.js')
    sendJson(res, 200, {
      admins: listAdmins(),
      knownUsers: listKnownImUsers(),
      configured: isAllowlistConfigured(),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

export async function handleAdminAllowlistAdd(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { platform?: string; userId?: string }
    const platform = (parsed.platform || '').trim()
    const userId = (parsed.userId || '').trim()
    if (!platform || !userId) {
      sendJson(res, 400, { error: 'platform and userId required' })
      return
    }
    const { promoteAdmin, listAdmins } = await import('../core/admin-allowlist.js')
    const added = await promoteAdmin(platform, userId, { actor: getRequestActor(req) })
    sendJson(res, 200, { ok: true, added, admins: listAdmins() })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

export async function handleAdminAllowlistRemove(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { platform?: string; userId?: string }
    const platform = (parsed.platform || '').trim().toLowerCase()
    const userId = (parsed.userId || '').trim()
    if (!platform || !userId) {
      sendJson(res, 400, { error: 'platform and userId required' })
      return
    }
    const { revokeAdmin, listAdmins } = await import('../core/admin-allowlist.js')
    const removed = await revokeAdmin(platform, userId, { actor: getRequestActor(req) })
    sendJson(res, 200, { ok: true, removed, admins: listAdmins() })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

export async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const { platform, threadId, text, card } = JSON.parse(body) as {
      platform?: string; threadId?: string; text?: string; card?: unknown
    }
    if (!platform || !threadId || (!text && !card)) {
      sendJson(res, 400, { error: 'Missing platform / threadId / (text|card)' })
      return
    }

    const messenger = resolveMessenger(platform)
    if (!messenger) {
      sendJson(res, 404, { error: `Messenger "${platform}" not registered` })
      return
    }

    const traceId = generateTraceId()
    const log = createLogger({ traceId, platform, component: 'notify' })
    log.info({ threadId, hasCard: !!card, textLen: text?.length || 0 }, 'notify in')

    if (card) {
      await sink.deliver({
        platform, channelId: 'rest', threadId,
        payload: card as object, kind: 'card',
      })
    } else if (text) {
      await sink.deliver({
        platform, channelId: 'rest', threadId,
        payload: text, kind: 'text',
      })
    } else {
      sendJson(res, 400, { error: 'card requires sendCard support, otherwise text is required' })
      return
    }

    sendJson(res, 200, { ok: true, traceId })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { error: msg })
  }
}

export async function handleInvoke(req: IncomingMessage, res: ServerResponse, defaultAgent: string): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body) as {
      prompt?: string; agent?: string; userId?: string; platform?: string
    }
    if (!parsed.prompt) {
      sendJson(res, 400, { error: 'Missing prompt' })
      return
    }
    const agentName = parsed.agent || defaultAgent
    const promptText = parsed.agent ? `/${parsed.agent} ${parsed.prompt}` : parsed.prompt

    const traceId = generateTraceId()
    const platform = parsed.platform || 'rest'
    const log = createLogger({ traceId, platform, component: 'invoke' })
    log.info({ agent: agentName, promptLen: parsed.prompt.length }, 'invoke in')

    const routeCtx = {
      threadId: `rest:${traceId}`,
      channelId: 'rest',
      platform,
      defaultAgent: agentName,
      traceId,
      logger: log,
      userId: parsed.userId || 'rest-caller',
    }

    const parsedMsg = parseMessage(promptText)
    const result = await routeMessage(parsedMsg, routeCtx)
    let fullText = ''
    if (typeof result === 'string') {
      fullText = result
    } else {
      for await (const chunk of result) fullText += chunk
    }
    sendJson(res, 200, { ok: true, traceId, output: { content: fullText } })
  } catch (err) {
    const e = err as Error & { statusCode?: number; handled?: boolean }
    if (e?.handled) return
    const status = e?.statusCode || 500
    const msg = e instanceof Error ? e.message : String(err)
    if (!res.headersSent) sendJson(res, status, { error: msg })
  }
}

export async function handleEmailTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await readBody(req, res)
    const host = process.env.AGIM_SMTP_HOST?.trim()
    const user = process.env.AGIM_SMTP_USER?.trim()
    const pass = process.env.AGIM_SMTP_PASS
    if (!host || !user || !pass) {
      sendError(res, 400, 'EMAIL_NOT_CONFIGURED', {
        message: 'SMTP not configured (host / user / pass required)',
        extra: { ok: false },
      })
      return
    }
    const portRaw = process.env.AGIM_SMTP_PORT?.trim()
    const portNum = portRaw ? Number.parseInt(portRaw, 10) : 465
    const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 465
    const secureRaw = process.env.AGIM_SMTP_SECURE?.trim().toLowerCase()
    const secure = secureRaw !== undefined
      ? (secureRaw === '1' || secureRaw === 'true' || secureRaw === 'yes')
      : port === 465

    const nodemailer = (await import('nodemailer')).default
    const tx = nodemailer.createTransport({
      host, port, secure,
      auth: { user, pass },
      connectionTimeout: 8000,
      greetingTimeout: 6000,
      socketTimeout: 8000,
    })
    try {
      await tx.verify()
      sendJson(res, 200, { ok: true, message: `Connected to ${host}:${port}` })
    } finally {
      tx.close()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sendError(res, 400, 'EMAIL_VERIFY_FAILED', {
      detail: msg,
      extra: { ok: false },
    })
  }
}
