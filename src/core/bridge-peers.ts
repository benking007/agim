// Bridge peers — production-side allowlist for the inbound bridge.
//
// File: ~/.agim/bridge-peers.json (mode 0600). The HMAC signing secret is
// stored in the clear because a later callback sender must have the raw
// key. Phase 1 never sends callbacks and never returns this secret over
// HTTP, in a job row, or in a log line.
//
// An empty `agents` list denies every agent. An empty callback URL means
// the peer is poll-only. Callback URL checks reuse schedule.ts and do not
// honor AGIM_ALLOW_PRIVATE_WEBHOOKS; a private host is allowed only when
// this peer record pins that exact hostname.

import { randomUUID } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'
import { assertWebhookHostPublic, validateWebhookUrl } from './schedule.js'

const log = rootLogger.child({ component: 'bridge-peers' })

function currentAgimHome(): string {
  return process.env.AGIM_HOME || AGIM_HOME
}

export function bridgePeersFile(): string {
  return join(currentAgimHome(), 'bridge-peers.json')
}

export interface BridgePeer {
  peerId: string
  tokenId: string
  /** Empty means deny every agent. */
  agents: string[]
  workspaceId: string
  /**
   * poll does not notify, even when a URL and key are stored.
   * webhook notifies only when both are present.
   * Omitted on old files: both present means webhook, otherwise poll.
   */
  callbackMode?: 'poll' | 'webhook'
  /** Stored webhook target. Ignored while callbackMode is poll. */
  callbackUrl: string | null
  /** Raw key for Authorization: Bearer. Ignored while callbackMode is poll. */
  signingSecret: string | null
  enabled: boolean
  /** In-flight inbound runs for this peer. Default 1. */
  maxConcurrent: number
  /**
   * Optional exact hostname that may be private or loopback.
   * Must equal the callback URL host. This is the per-peer exception;
   * it is not the global private-webhook switch.
   */
  callbackPinnedHost: string | null
}

/** Caller-side record of a remote production bridge. The raw token stays in this file only. */
export interface BridgeOutboundTarget {
  peerId: string
  /** Production bridge origin, no path. Example: https://agim.example */
  baseUrl: string
  token: string
  /** Null when this caller only polls. */
  signingSecret: string | null
  agents: string[]
}

interface PeerFile {
  peers?: BridgePeer[]
  outbound?: BridgeOutboundTarget[]
}

export class BridgePeerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgePeerError'
  }
}

const PEER_ID_RE = /^[^\s:]{1,128}$/

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeLoaded(raw: unknown): BridgePeer | null {
  const row = asRecord(raw)
  if (!row) return null
  const peerId = typeof row.peerId === 'string' ? row.peerId : ''
  const tokenId = typeof row.tokenId === 'string' ? row.tokenId : ''
  const workspaceId = typeof row.workspaceId === 'string' ? row.workspaceId : ''
  if (!PEER_ID_RE.test(peerId) || !tokenId || !workspaceId) return null
  const agents = Array.isArray(row.agents)
    ? row.agents.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : []
  const callbackUrl = typeof row.callbackUrl === 'string' && row.callbackUrl.trim()
    ? row.callbackUrl.trim()
    : null
  const signingSecret = typeof row.signingSecret === 'string' && row.signingSecret
    ? row.signingSecret
    : null
  const callbackPinnedHost = typeof row.callbackPinnedHost === 'string' && row.callbackPinnedHost.trim()
    ? row.callbackPinnedHost.trim().toLowerCase()
    : null
  const maxRaw = row.maxConcurrent
  const maxConcurrent = typeof maxRaw === 'number' && Number.isInteger(maxRaw) && maxRaw >= 1
    ? maxRaw
    : 1
  const callbackMode = row.callbackMode === 'poll' || row.callbackMode === 'webhook'
    ? row.callbackMode
    : (callbackUrl && signingSecret ? 'webhook' : 'poll')
  return {
    peerId,
    tokenId,
    agents,
    workspaceId,
    callbackMode,
    callbackUrl,
    signingSecret,
    enabled: row.enabled !== false,
    maxConcurrent,
    callbackPinnedHost,
  }
}

export function loadBridgePeers(): BridgePeer[] {
  const path = bridgePeersFile()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as PeerFile
    const rows = Array.isArray(parsed?.peers) ? parsed.peers : []
    const peers: BridgePeer[] = []
    for (const row of rows) {
      const peer = normalizeLoaded(row)
      if (peer) peers.push(peer)
    }
    return peers
  } catch (err) {
    log.warn({ event: 'bridge-peers.read_failed', err: String(err) },
      'bridge-peers.json unreadable; treating the allowlist as empty')
    return []
  }
}

export function findPeerByTokenId(tokenId: string): BridgePeer | null {
  if (!tokenId) return null
  return loadBridgePeers().find((peer) => peer.tokenId === tokenId) ?? null
}

/** How this caller is notified. Old files with both a URL and a key are webhook. */
export function effectiveCallbackMode(peer: {
  callbackMode?: string | null
  callbackUrl?: string | null
  signingSecret?: string | null
}): 'poll' | 'webhook' {
  if (peer.callbackMode === 'poll') return 'poll'
  if (peer.callbackMode === 'webhook') return 'webhook'
  if (peer.callbackMode == null || peer.callbackMode === '') {
    return peer.callbackUrl && peer.signingSecret ? 'webhook' : 'poll'
  }
  return 'poll'
}

export function findPeerById(peerId: string): BridgePeer | null {
  if (!peerId) return null
  return loadBridgePeers().find((peer) => peer.peerId === peerId) ?? null
}

/**
 * Check a callback URL the way the bridge is allowed to: the schedule
 * helpers, with the global private-webhook switch forced off for the
 * duration of the call. A pinned hostname is the only private exception.
 */
export async function validateBridgeCallbackUrl(
  raw: string,
  pinnedHost: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL
  try { parsed = new URL(raw) } catch {
    return { ok: false, reason: 'malformed URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `protocol ${parsed.protocol} not allowed` }
  }
  const host = parsed.hostname.toLowerCase()
  const pin = pinnedHost?.trim().toLowerCase() || ''
  if (pin && host !== pin) {
    return { ok: false, reason: 'callback host does not match callbackPinnedHost' }
  }

  const saved = process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS
  delete process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS
  try {
    const lexical = validateWebhookUrl(raw)
    if (!lexical.ok) {
      if (pin && host === pin) return { ok: true }
      return { ok: false, reason: lexical.reason }
    }
    if (pin && host === pin) return { ok: true }
    const pub = await assertWebhookHostPublic(lexical.url.hostname)
    if (!pub.ok) return { ok: false, reason: pub.reason }
    return { ok: true }
  } finally {
    if (saved === undefined) delete process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS
    else process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS = saved
  }
}

function assertPeerShape(peer: BridgePeer, index: number): void {
  if (!PEER_ID_RE.test(peer.peerId)) {
    throw new BridgePeerError(`peer ${index} has an invalid peerId`)
  }
  if (!peer.tokenId || typeof peer.tokenId !== 'string') {
    throw new BridgePeerError(`peer ${peer.peerId} is missing tokenId`)
  }
  if (!peer.workspaceId || typeof peer.workspaceId !== 'string' || /\s/.test(peer.workspaceId)) {
    throw new BridgePeerError(`peer ${peer.peerId} is missing workspaceId`)
  }
  if (!Array.isArray(peer.agents) || peer.agents.some((name) => typeof name !== 'string' || !name)) {
    throw new BridgePeerError(`peer ${peer.peerId} has an invalid agents list`)
  }
  if (!Number.isInteger(peer.maxConcurrent) || peer.maxConcurrent < 1) {
    throw new BridgePeerError(`peer ${peer.peerId} maxConcurrent must be an integer >= 1`)
  }
  if (typeof peer.enabled !== 'boolean') {
    throw new BridgePeerError(`peer ${peer.peerId} enabled must be a boolean`)
  }
  if (peer.callbackMode != null && peer.callbackMode !== 'poll' && peer.callbackMode !== 'webhook') {
    throw new BridgePeerError(`peer ${peer.peerId} callbackMode must be poll or webhook`)
  }
}

function readPeerFile(): PeerFile {
  const path = bridgePeersFile()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as PeerFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePeerFile(next: PeerFile): void {
  const path = bridgePeersFile()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const payload = `${JSON.stringify(next, null, 2)}\n`
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmpPath, path)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
  try { chmodSync(path, 0o600) } catch { /* ignore non-POSIX */ }
}

function normalizeOutbound(raw: unknown): BridgeOutboundTarget | null {
  const row = asRecord(raw)
  if (!row) return null
  const peerId = typeof row.peerId === 'string' ? row.peerId : ''
  const baseUrl = typeof row.baseUrl === 'string' ? row.baseUrl.replace(/\/+$/, '') : ''
  const token = typeof row.token === 'string' ? row.token : ''
  if (!PEER_ID_RE.test(peerId) || !token || !baseUrl) return null
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const agents = Array.isArray(row.agents)
    ? row.agents.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : []
  const signingSecret = typeof row.signingSecret === 'string' && row.signingSecret
    ? row.signingSecret
    : null
  return { peerId, baseUrl, token, signingSecret, agents }
}

export function loadOutboundTargets(): BridgeOutboundTarget[] {
  const rows = readPeerFile().outbound
  if (!Array.isArray(rows)) return []
  const targets: BridgeOutboundTarget[] = []
  for (const row of rows) {
    const target = normalizeOutbound(row)
    if (target) targets.push(target)
  }
  return targets
}

export function findOutboundTarget(peerId: string): BridgeOutboundTarget | null {
  if (!peerId) return null
  return loadOutboundTargets().find((row) => row.peerId === peerId) ?? null
}

export function saveOutboundTargets(targets: BridgeOutboundTarget[]): void {
  const seen = new Set<string>()
  const normalized: BridgeOutboundTarget[] = []
  for (const target of targets) {
    const row = normalizeOutbound(target)
    if (!row) throw new BridgePeerError('outbound target is missing peerId, baseUrl, or token')
    if (seen.has(row.peerId)) throw new BridgePeerError(`duplicate outbound peerId ${row.peerId}`)
    seen.add(row.peerId)
    normalized.push(row)
  }
  const current = readPeerFile()
  writePeerFile({ peers: Array.isArray(current.peers) ? current.peers : [], outbound: normalized })
}

export async function saveBridgePeers(peers: BridgePeer[]): Promise<void> {
  const seenPeers = new Set<string>()
  const seenTokens = new Set<string>()
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i]
    assertPeerShape(peer, i)
    if (seenPeers.has(peer.peerId)) throw new BridgePeerError(`duplicate peerId ${peer.peerId}`)
    if (seenTokens.has(peer.tokenId)) throw new BridgePeerError(`duplicate tokenId ${peer.tokenId}`)
    seenPeers.add(peer.peerId)
    seenTokens.add(peer.tokenId)
    const url = peer.callbackUrl?.trim() || ''
    const pin = peer.callbackPinnedHost?.trim().toLowerCase() || null
    if (!url) {
      if (pin) throw new BridgePeerError(`peer ${peer.peerId} pins a callback host but has no callback URL`)
      continue
    }
    if (!peer.signingSecret) {
      throw new BridgePeerError(`peer ${peer.peerId} callback URL requires a signing secret`)
    }
    const checked = await validateBridgeCallbackUrl(url, pin)
    if (!checked.ok) throw new BridgePeerError(`peer ${peer.peerId} callback URL: ${checked.reason}`)
  }

  const current = readPeerFile()
  writePeerFile({
    peers,
    outbound: Array.isArray(current.outbound) ? current.outbound : [],
  })
}
