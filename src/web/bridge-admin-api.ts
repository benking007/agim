// Admin connection settings for bridge tokens and inbound peers.
//
// The raw token and the handoff prompt exist only in the create response.
// Listing never returns them. Signing secrets are not accepted or returned.
// A null callback URL means poll only. A blank webhookKey on edit keeps
// the stored key. webhookKey null removes it.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createToken,
  listBridgeTokens,
  revokeBridgeToken,
} from '../core/access-token.js'
import {
  BridgePeerError,
  effectiveCallbackMode,
  loadBridgePeers,
  saveBridgePeers,
  type BridgePeer,
} from '../core/bridge-peers.js'
import { isBridgeEnabled, setBridgeEnabled } from '../core/bridge-switch.js'
import { getRequestUserId, requireAdmin } from './auth.js'
import {
  buildBridgeCallerPrompt,
  bridgeCallerGuideUrl,
  resolveBridgePublicBase,
} from './bridge-caller-guide.js'
import { readBody, sendError, sendJson } from './http-utils.js'

const LABEL_MAX = 80
const SECRET_FIELDS = ['signingSecret', 'token', 'raw', 'hash', 'callerPrompt'] as const

interface PublicPeer {
  peerId: string
  tokenId: string
  agents: string[]
  callbackMode: 'poll' | 'webhook'
  callbackUrl: string | null
  /** True when a signing key is stored. The key itself is never returned. */
  webhookKeySet: boolean
  enabled: boolean
  maxConcurrent: number
  workspaceId: string
}

function actorOf(req: IncomingMessage): string {
  const userId = getRequestUserId(req)
  return userId ? `web:${userId}` : 'web:admin'
}

function publicPeer(peer: BridgePeer): PublicPeer {
  return {
    peerId: peer.peerId,
    tokenId: peer.tokenId,
    agents: peer.agents,
    callbackMode: effectiveCallbackMode(peer),
    callbackUrl: peer.callbackUrl,
    webhookKeySet: Boolean(peer.signingSecret),
    enabled: peer.enabled,
    maxConcurrent: peer.maxConcurrent,
    workspaceId: peer.workspaceId,
  }
}

function hasSecretField(body: Record<string, unknown>): boolean {
  return SECRET_FIELDS.some((key) => key in body)
}

function asAgents(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const agents: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const name = item.trim()
    if (!name || agents.includes(name)) continue
    agents.push(name)
  }
  return agents
}

function asMaxConcurrent(value: unknown): number | null {
  if (value == null) return 1
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) return null
  return value
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try {
    const text = await readBody(req, res)
    const value = JSON.parse(text || '{}') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      sendError(res, 400, 'VALIDATION', { message: 'JSON object required' })
      return null
    }
    return value as Record<string, unknown>
  } catch (err) {
    const handled = (err as { handled?: boolean }).handled
    if (handled || res.headersSent) return null
    sendError(res, 400, 'VALIDATION', { message: 'Invalid JSON body' })
    return null
  }
}

function liveBridgeToken(tokenId: string): boolean {
  return listBridgeTokens().some((row) => row.id === tokenId && !row.revoked)
}

function asCallbackMode(value: unknown): 'poll' | 'webhook' | null {
  if (value === 'poll' || value === 'webhook') return value
  return null
}

/**
 * Page fields are callbackUrl and webhookKey. The stored field stays signingSecret.
 * On edit, an omitted or blank webhookKey keeps the stored key. null clears it.
 * Both a URL and a key are required before a caller is notified.
 */
function readWebhook(
  body: Record<string, unknown>,
  existing: { callbackUrl: string | null; signingSecret: string | null } | null,
  mode: 'create' | 'patch',
): { callbackUrl: string | null; signingSecret: string | null } | { error: string } | 'keep' {
  const hasUrl = Object.hasOwn(body, 'callbackUrl')
  const hasKey = Object.hasOwn(body, 'webhookKey')
  if (mode === 'patch' && !hasUrl && !hasKey) return 'keep'
  if (hasKey && body.webhookKey !== null && typeof body.webhookKey !== 'string') {
    return { error: 'webhook key must be a string or null' }
  }
  if (mode === 'create' && body.webhookKey === null) {
    return { error: 'webhook key must be a string' }
  }

  const url = hasUrl
    ? (typeof body.callbackUrl === 'string' ? body.callbackUrl.trim() : '')
    : (existing?.callbackUrl || '')
  const typedKey = hasKey && typeof body.webhookKey === 'string' ? body.webhookKey.trim() : ''
  const clearKey = mode === 'patch' && hasKey && body.webhookKey === null
  const secret = clearKey ? '' : (typedKey || existing?.signingSecret || '')

  if (mode === 'create') {
    if (!url && !typedKey) return { callbackUrl: null, signingSecret: null }
    if (!url) return { error: 'webhook URL is required when a key is set' }
    if (!typedKey) return { error: 'webhook key is required when a URL is set' }
    return { callbackUrl: url, signingSecret: typedKey }
  }
  if (typedKey && !url) return { error: 'webhook URL is required when a key is set' }
  if (url && !secret) return { error: 'webhook key is required when a URL is set' }
  return { callbackUrl: url || null, signingSecret: secret || null }
}

async function handleListTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    tokens: listBridgeTokens(),
    publicBaseUrl: resolveBridgePublicBase(req),
  })
}

async function handleCreateToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res)
  if (!body) return
  if (body.role !== undefined && body.role !== 'bridge') {
    sendError(res, 400, 'VALIDATION', { message: 'role must be bridge' })
    return
  }
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label || label.length > LABEL_MAX) {
    sendError(res, 400, 'VALIDATION', { message: 'label is required' })
    return
  }
  const manual = typeof body.baseUrl === 'string' ? body.baseUrl : null
  const base = resolveBridgePublicBase(req, manual)
  if (!base) {
    sendError(res, 400, 'VALIDATION', { message: 'public base URL is required' })
    return
  }
  const created = createToken(label, { role: 'bridge', actor: actorOf(req) })
  const callerPrompt = buildBridgeCallerPrompt(created.raw, base)
  sendJson(res, 201, {
    ok: true,
    id: created.id,
    label,
    role: 'bridge' as const,
    raw: created.raw,
    publicBaseUrl: base,
    guideUrl: bridgeCallerGuideUrl(base),
    callerPrompt,
  })
}

function handleRevokeToken(req: IncomingMessage, res: ServerResponse, id: string): void {
  const ok = revokeBridgeToken(id, { actor: actorOf(req) })
  if (!ok) {
    sendError(res, 404, 'NOT_FOUND', { message: 'bridge token not found' })
    return
  }
  sendJson(res, 200, { ok: true })
}

function handleListPeers(res: ServerResponse): void {
  sendJson(res, 200, { peers: loadBridgePeers().map(publicPeer) })
}

async function handleCreatePeer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res)
  if (!body) return
  if (hasSecretField(body) || 'callbackPinnedHost' in body) {
    sendError(res, 400, 'VALIDATION', { message: 'signing secret is not accepted' })
    return
  }
  const webhook = readWebhook(body, null, 'create')
  if (webhook === 'keep' || 'error' in webhook) {
    sendError(res, 400, 'VALIDATION', { message: webhook === 'keep' ? 'webhook rejected' : webhook.error })
    return
  }
  const peerId = typeof body.peerId === 'string' ? body.peerId.trim() : ''
  const tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim() : ''
  const agents = asAgents(body.agents)
  const maxConcurrent = asMaxConcurrent(body.maxConcurrent)
  const workspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim()
    ? body.workspaceId.trim()
    : 'default'
  if (!peerId || !tokenId || !agents || maxConcurrent == null) {
    sendError(res, 400, 'VALIDATION', { message: 'peerId, tokenId, and agents are required' })
    return
  }
  if (!liveBridgeToken(tokenId)) {
    sendError(res, 400, 'VALIDATION', { message: 'tokenId must be an active bridge token' })
    return
  }
  let callbackMode: 'poll' | 'webhook'
  if (Object.hasOwn(body, 'callbackMode')) {
    const parsed = asCallbackMode(body.callbackMode)
    if (!parsed) {
      sendError(res, 400, 'VALIDATION', { message: 'callbackMode must be poll or webhook' })
      return
    }
    callbackMode = parsed
  } else {
    callbackMode = webhook.callbackUrl && webhook.signingSecret ? 'webhook' : 'poll'
  }
  const peer: BridgePeer = {
    peerId,
    tokenId,
    agents,
    workspaceId,
    callbackMode,
    callbackUrl: webhook.callbackUrl,
    signingSecret: webhook.signingSecret,
    enabled: body.enabled !== false,
    maxConcurrent,
    callbackPinnedHost: null,
  }
  try {
    await saveBridgePeers([...loadBridgePeers(), peer])
  } catch (err) {
    const message = err instanceof BridgePeerError ? err.message : 'peer rejected'
    sendError(res, 400, 'VALIDATION', { message })
    return
  }
  sendJson(res, 201, { ok: true, peer: publicPeer(peer) })
}

async function handlePatchPeer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res)
  if (!body) return
  if (hasSecretField(body) || 'callbackPinnedHost' in body) {
    sendError(res, 400, 'VALIDATION', { message: 'signing secret is not accepted' })
    return
  }
  const peerId = typeof body.peerId === 'string' ? body.peerId.trim() : ''
  const peers = loadBridgePeers()
  const index = peers.findIndex((peer) => peer.peerId === peerId)
  if (!peerId || index < 0) {
    sendError(res, 404, 'NOT_FOUND', { message: 'peer not found' })
    return
  }
  const current = peers[index]
  if (!current) return
  const next: BridgePeer = { ...current }
  const webhook = readWebhook(body, current, 'patch')
  if (webhook !== 'keep') {
    if ('error' in webhook) {
      sendError(res, 400, 'VALIDATION', { message: webhook.error })
      return
    }
    next.callbackUrl = webhook.callbackUrl
    next.signingSecret = webhook.signingSecret
    next.callbackPinnedHost = null
  }
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled
  if (body.agents !== undefined) {
    const agents = asAgents(body.agents)
    if (!agents) {
      sendError(res, 400, 'VALIDATION', { message: 'agents must be a string list' })
      return
    }
    next.agents = agents
  }
  if (body.maxConcurrent !== undefined) {
    const maxConcurrent = asMaxConcurrent(body.maxConcurrent)
    if (maxConcurrent == null) {
      sendError(res, 400, 'VALIDATION', { message: 'maxConcurrent must be an integer from 1 to 100' })
      return
    }
    next.maxConcurrent = maxConcurrent
  }
  if (body.workspaceId !== undefined) {
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
    if (!workspaceId || /\s/.test(workspaceId)) {
      sendError(res, 400, 'VALIDATION', { message: 'workspaceId is required' })
      return
    }
    next.workspaceId = workspaceId
  }
  if (Object.hasOwn(body, 'callbackMode')) {
    const callbackMode = asCallbackMode(body.callbackMode)
    if (!callbackMode) {
      sendError(res, 400, 'VALIDATION', { message: 'callbackMode must be poll or webhook' })
      return
    }
    next.callbackMode = callbackMode
  }
  peers[index] = next
  try {
    await saveBridgePeers(peers)
  } catch (err) {
    const message = err instanceof BridgePeerError ? err.message : 'peer rejected'
    sendError(res, 400, 'VALIDATION', { message })
    return
  }
  sendJson(res, 200, { ok: true, peer: publicPeer(next) })
}

export async function handleBridgeAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  if (p !== '/api/admin/bridge' && !p.startsWith('/api/admin/bridge/')) return false
  if (!requireAdmin(req, res)) return true
  const m = (req.method || 'GET').toUpperCase()

  if (p === '/api/admin/bridge/enabled' && m === 'GET') {
    sendJson(res, 200, { enabled: isBridgeEnabled() })
    return true
  }
  if (p === '/api/admin/bridge/enabled' && m === 'PUT') {
    const body = await readJson(req, res)
    if (!body) return true
    if (typeof body.enabled !== 'boolean') {
      sendError(res, 400, 'VALIDATION', { message: 'enabled must be a boolean' })
      return true
    }
    const enabled = await setBridgeEnabled(body.enabled)
    sendJson(res, 200, { enabled })
    return true
  }
  if (p === '/api/admin/bridge/tokens' && m === 'GET') {
    await handleListTokens(req, res)
    return true
  }
  if (p === '/api/admin/bridge/tokens' && m === 'POST') {
    await handleCreateToken(req, res)
    return true
  }
  const bridgeAdminTokenMatch = p.match(/^\/api\/admin\/bridge\/tokens\/([^/]+)$/)
  if (bridgeAdminTokenMatch && m === 'DELETE') {
    handleRevokeToken(req, res, decodeURIComponent(bridgeAdminTokenMatch[1] || ''))
    return true
  }
  if (p === '/api/admin/bridge/peers' && m === 'GET') {
    handleListPeers(res)
    return true
  }
  if (p === '/api/admin/bridge/peers' && m === 'POST') {
    await handleCreatePeer(req, res)
    return true
  }
  if (p === '/api/admin/bridge/peers' && m === 'PATCH') {
    await handlePatchPeer(req, res)
    return true
  }
  sendError(res, 404, 'NOT_FOUND', { message: 'not found' })
  return true
}
