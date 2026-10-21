// MCP Events for bridge runs.
//
// Subscriptions keep ChatGPT's delivery URL and secret on their own rows.
// They never write the caller's Webhook URL or Key. OAuth is not wired:
// nothing here accepts the bridge token as a plugin login.
//
// A finished run emits one agim.run.finished event. Delivery failure is
// recorded here and does not change the job.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import https from 'node:https'
import { effectiveCallbackMode, findPeerById, validateBridgeCallbackUrl } from './bridge-peers.js'
import { getJob, withJobsDatabase } from './job-board.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'bridge-mcp-events' })

export const MCP_EVENT_NAME = 'agim.run.finished'
/** No authenticated plugin subject until MCP OAuth exists. */
export const MCP_EVENTS_PRINCIPAL = 'oauth-not-configured'
const REFRESH_MS = 24 * 60 * 60 * 1000
const VERIFY_CACHE_MS = 10 * 60 * 1000
const POST_TIMEOUT_MS = 10_000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bridge_mcp_subscriptions (
    id               TEXT PRIMARY KEY,
    principal        TEXT NOT NULL,
    name             TEXT NOT NULL,
    arguments_json   TEXT NOT NULL,
    run_id           TEXT,
    delivery_url     TEXT NOT NULL,
    delivery_secret  TEXT NOT NULL,
    active           INTEGER NOT NULL DEFAULT 0,
    refresh_before   TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bridge_mcp_deliveries (
    subscription_id  TEXT NOT NULL,
    event_id         TEXT NOT NULL,
    status           TEXT NOT NULL,
    body             TEXT NOT NULL,
    PRIMARY KEY (subscription_id, event_id)
  );
`

export interface McpPostOptions {
  caPem?: string
  /** Test-only exact host that may be loopback. Production passes null. */
  pinnedHost?: string | null
}

type SendResult = { status: number; body: string } | { networkError: string }

interface SubscriptionRow {
  id: string
  principal: string
  name: string
  arguments_json: string
  run_id: string | null
  delivery_url: string
  delivery_secret: string
  active: number
  refresh_before: string | null
}

const verifiedUntil = new Map<string, number>()

function withMcpDb<T>(fn: (db: import('better-sqlite3').Database) => T): T | null {
  return withJobsDatabase((db) => {
    db.exec(SCHEMA)
    return fn(db)
  })
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(rec[key])}`).join(',')}}`
}

export function parseWhsec(secret: string): Buffer | null {
  if (!secret.startsWith('whsec_')) return null
  const raw = secret.slice('whsec_'.length)
  const buf = Buffer.from(raw, 'base64')
  if (buf.length < 24 || buf.length > 64) return null
  const again = buf.toString('base64').replace(/=+$/, '')
  if (again !== raw.replace(/=+$/, '')) return null
  return buf
}

/** Standard Webhooks HMAC: v1,base64(HMAC_SHA256(secret, id.timestamp.body)). */
export function signStandardWebhook(secret: string, webhookId: string, timestampSec: string, body: string): string | null {
  const key = parseWhsec(secret)
  if (!key) return null
  const mac = createHmac('sha256', key).update(`${webhookId}.${timestampSec}.${body}`).digest('base64')
  return `v1,${mac}`
}

export function stableFinishedEventId(runId: string, status: string): string {
  const hex = createHash('sha256').update(`${runId}:${status}`).digest('hex').slice(0, 32)
  return `evt_${hex}`
}

function subscriptionId(principal: string, url: string, name: string, argumentsJson: string): string {
  const hex = createHash('sha256').update(`${principal}\n${url}\n${name}\n${argumentsJson}`).digest('base64url').slice(0, 22)
  return `sub_${hex}`
}

function stringsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function postHttps(url: string, body: string, headers: Record<string, string>, caPem?: string): Promise<SendResult> {
  return new Promise((resolve) => {
    let target: URL
    try { target = new URL(url) } catch {
      resolve({ networkError: 'malformed URL' })
      return
    }
    if (target.protocol !== 'https:') {
      resolve({ networkError: 'https required' })
      return
    }
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: POST_TIMEOUT_MS,
      rejectUnauthorized: true,
      ...(caPem ? { ca: caPem } : {}),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ networkError: 'timeout' })
    })
    req.on('error', (err) => resolve({ networkError: err.message }))
    req.end(body)
  })
}

async function assertPublicHttps(url: string, pinnedHost: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL
  try { parsed = new URL(url) } catch {
    return { ok: false, reason: 'malformed URL' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'https required' }
  return validateBridgeCallbackUrl(url, pinnedHost)
}

async function signedPost(
  url: string,
  secret: string,
  subscriptionIdValue: string,
  webhookId: string,
  body: string,
  opts: McpPostOptions,
): Promise<SendResult> {
  const allowed = await assertPublicHttps(url, opts.pinnedHost ?? null)
  if (!allowed.ok) return { networkError: allowed.reason }
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signStandardWebhook(secret, webhookId, timestamp, body)
  if (!signature) return { networkError: 'invalid signing secret' }
  return postHttps(url, body, {
    'webhook-id': webhookId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
    'X-MCP-Subscription-Id': subscriptionIdValue,
  }, opts.caPem)
}

function parseFilter(args: unknown): { ok: true; runId: string | null; canonical: string } | { ok: false; message: string } {
  if (args == null) return { ok: true, runId: null, canonical: '{}' }
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, message: 'arguments must be an object' }
  const rec = args as Record<string, unknown>
  if (Object.keys(rec).some((key) => key !== 'runId')) return { ok: false, message: 'unsupported subscription argument' }
  if (rec.runId == null) return { ok: true, runId: null, canonical: '{}' }
  if (typeof rec.runId !== 'string' || rec.runId.length === 0) return { ok: false, message: 'runId must be a string' }
  return { ok: true, runId: rec.runId, canonical: canonicalJson({ runId: rec.runId }) }
}

export function listMcpEvents(): { events: unknown[] } {
  return {
    events: [{
      name: MCP_EVENT_NAME,
      description: 'A bridge run reached a terminal status. Read the full result with agim_get_run.',
      delivery: ['webhook'],
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'When set, only this run. Omit for later terminal runs.' },
        },
        additionalProperties: false,
      },
      payloadSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          jobId: { type: 'number' },
          status: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
        },
        required: ['runId', 'jobId', 'status'],
        additionalProperties: false,
      },
    }],
  }
}

function refreshBeforeIso(ttlMs: unknown): string | { error: string } {
  const grant = ttlMs == null ? REFRESH_MS : ttlMs
  if (typeof grant !== 'number' || !Number.isInteger(grant) || grant <= 0) {
    return { error: 'ttlMs must be a positive integer or omitted' }
  }
  const ms = Math.min(grant, REFRESH_MS)
  return new Date(Date.now() + ms).toISOString()
}

async function verifyCallback(row: SubscriptionRow, opts: McpPostOptions): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cacheKey = `${row.principal}\n${row.delivery_url}`
  const until = verifiedUntil.get(cacheKey) ?? 0
  if (until > Date.now()) return { ok: true }
  const challenge = randomBytes(24).toString('hex')
  const webhookId = `msg_verification_${randomBytes(8).toString('hex')}`
  const body = JSON.stringify({ type: 'verification', challenge })
  const sent = await signedPost(row.delivery_url, row.delivery_secret, row.id, webhookId, body, opts)
  if ('networkError' in sent) return { ok: false, reason: sent.networkError }
  if (sent.status < 200 || sent.status >= 300) return { ok: false, reason: 'challenge_failed' }
  let echoed = ''
  try {
    const parsed = JSON.parse(sent.body) as { challenge?: unknown }
    if (typeof parsed.challenge === 'string') echoed = parsed.challenge
  } catch {
    return { ok: false, reason: 'challenge_failed' }
  }
  if (!stringsEqual(echoed, challenge)) return { ok: false, reason: 'challenge_failed' }
  verifiedUntil.set(cacheKey, Date.now() + VERIFY_CACHE_MS)
  return { ok: true }
}

export interface SubscribeInput {
  name?: unknown
  arguments?: unknown
  delivery?: unknown
  ttlMs?: unknown
}

export async function subscribeMcpEvent(
  input: SubscribeInput,
  opts: McpPostOptions = {},
): Promise<{ ok: true; id: string; refreshBefore: string; cursor: null; truncated: false } | { ok: false; code: number; message: string; reason?: string }> {
  if (input.name !== MCP_EVENT_NAME) return { ok: false, code: -32602, message: 'unsupported event' }
  const filter = parseFilter(input.arguments)
  if (!filter.ok) return { ok: false, code: -32602, message: filter.message }
  const delivery = input.delivery
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    return { ok: false, code: -32602, message: 'delivery is required' }
  }
  const rec = delivery as Record<string, unknown>
  if (rec.mode !== 'webhook') return { ok: false, code: -32602, message: 'delivery.mode must be webhook' }
  if (typeof rec.url !== 'string' || typeof rec.secret !== 'string') {
    return { ok: false, code: -32602, message: 'delivery url and secret are required' }
  }
  if (!parseWhsec(rec.secret)) return { ok: false, code: -32602, message: 'delivery.secret must be a whsec_ key of 24–64 bytes' }
  const url = rec.url.trim()
  const allowed = await assertPublicHttps(url, opts.pinnedHost ?? null)
  if (!allowed.ok) return { ok: false, code: -32015, message: 'callback URL was rejected', reason: allowed.reason }
  const refresh = refreshBeforeIso(input.ttlMs)
  if (typeof refresh !== 'string') return { ok: false, code: -32602, message: refresh.error }
  const id = subscriptionId(MCP_EVENTS_PRINCIPAL, url, MCP_EVENT_NAME, filter.canonical)
  const saved = withMcpDb((db) => {
    db.prepare(
      `INSERT INTO bridge_mcp_subscriptions (
         id, principal, name, arguments_json, run_id, delivery_url, delivery_secret, active, refresh_before
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         delivery_secret = excluded.delivery_secret,
         refresh_before = excluded.refresh_before,
         active = 0`,
    ).run(id, MCP_EVENTS_PRINCIPAL, MCP_EVENT_NAME, filter.canonical, filter.runId, url, rec.secret, refresh)
    return db.prepare('SELECT * FROM bridge_mcp_subscriptions WHERE id = ?').get(id) as SubscriptionRow
  })
  if (!saved) return { ok: false, code: -32015, message: 'subscription store unavailable', reason: 'timeout' }
  const verified = await verifyCallback(saved, opts)
  if (!verified.ok) {
    withMcpDb((db) => {
      db.prepare('DELETE FROM bridge_mcp_subscriptions WHERE id = ? AND active = 0').run(id)
    })
    return { ok: false, code: -32015, message: 'callback verification failed', reason: verified.reason }
  }
  withMcpDb((db) => {
    db.prepare('UPDATE bridge_mcp_subscriptions SET active = 1, refresh_before = ? WHERE id = ?').run(refresh, id)
  })
  if (filter.runId) await deliverFinishedRun(filter.runId, opts)
  return { ok: true, id, refreshBefore: refresh, cursor: null, truncated: false }
}

export function unsubscribeMcpEvent(input: SubscribeInput): { ok: true } | { ok: false; code: number; message: string } {
  if (input.name !== MCP_EVENT_NAME) return { ok: false, code: -32602, message: 'unsupported event' }
  const filter = parseFilter(input.arguments)
  if (!filter.ok) return { ok: false, code: -32602, message: filter.message }
  const delivery = input.delivery
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    return { ok: false, code: -32602, message: 'delivery is required' }
  }
  const url = typeof (delivery as { url?: unknown }).url === 'string' ? (delivery as { url: string }).url.trim() : ''
  if (!url) return { ok: false, code: -32602, message: 'delivery.url is required' }
  const id = subscriptionId(MCP_EVENTS_PRINCIPAL, url, MCP_EVENT_NAME, filter.canonical)
  withMcpDb((db) => {
    db.prepare('DELETE FROM bridge_mcp_subscriptions WHERE id = ?').run(id)
  })
  return { ok: true }
}

function finishedBody(runId: string, jobId: number, status: string): { eventId: string; body: string } {
  const eventId = stableFinishedEventId(runId, status)
  const body = JSON.stringify({
    eventId,
    name: MCP_EVENT_NAME,
    timestamp: new Date().toISOString(),
    data: { runId, jobId, status },
    cursor: null,
  })
  return { eventId, body }
}

async function postDelivery(row: SubscriptionRow, eventId: string, body: string, opts: McpPostOptions): Promise<'delivered' | 'failed'> {
  const sent = await signedPost(row.delivery_url, row.delivery_secret, row.id, eventId, body, opts)
  if ('networkError' in sent) return 'failed'
  if (sent.status >= 200 && sent.status < 300) return 'delivered'
  return 'failed'
}

/** Deliver agim.run.finished for one run when it is already terminal. */
let testPostOpts: McpPostOptions | null = null

export async function deliverFinishedRun(runId: string, opts: McpPostOptions = testPostOpts ?? {}): Promise<void> {
  const loaded = withMcpDb((db) => {
    const run = db.prepare(
      `SELECT run_id, job_id, peer_id FROM bridge_runs WHERE run_id = ? AND direction = 'inbound'`,
    ).get(runId) as { run_id: string; job_id: number; peer_id: string } | undefined
    return run ?? null
  })
  if (!loaded) return
  const peer = findPeerById(loaded.peer_id)
  if (!peer || effectiveCallbackMode(peer) !== 'mcp_events') return
  const job = getJob(loaded.job_id)
  if (!job) return
  if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') return
  const built = finishedBody(loaded.run_id, loaded.job_id, job.status)
  const subs = withMcpDb((db) => db.prepare(
    `SELECT * FROM bridge_mcp_subscriptions
      WHERE active = 1 AND name = ? AND (run_id IS NULL OR run_id = ?)`,
  ).all(MCP_EVENT_NAME, loaded.run_id) as SubscriptionRow[]) ?? []
  const now = Date.now()
  for (const sub of subs) {
    if (sub.refresh_before && Date.parse(sub.refresh_before) <= now) continue
    const gate = withMcpDb((db) => {
      db.prepare(
        `INSERT INTO bridge_mcp_deliveries (subscription_id, event_id, status, body)
         VALUES (?, ?, 'pending', ?)
         ON CONFLICT(subscription_id, event_id) DO NOTHING`,
      ).run(sub.id, built.eventId, built.body)
      return db.prepare(
        'SELECT status, body FROM bridge_mcp_deliveries WHERE subscription_id = ? AND event_id = ?',
      ).get(sub.id, built.eventId) as { status: string; body: string } | undefined
    })
    if (!gate || gate.status === 'delivered') continue
    let outcome: 'delivered' | 'failed' = 'failed'
    try {
      outcome = await postDelivery(sub, built.eventId, gate.body, opts)
    } catch (err) {
      log.warn({ event: 'bridge-mcp.post_failed', subscriptionId: sub.id, err: err instanceof Error ? err.message : 'post' },
        'mcp event post failed')
    }
    withMcpDb((db) => {
      db.prepare(
        'UPDATE bridge_mcp_deliveries SET status = ? WHERE subscription_id = ? AND event_id = ?',
      ).run(outcome, sub.id, built.eventId)
    })
    if (outcome === 'failed') {
      log.warn({ event: 'bridge-mcp.delivery_failed', subscriptionId: sub.id, runId: loaded.run_id },
        'mcp event was not accepted')
    }
  }
}

let chain: Promise<void> = Promise.resolve()

/** Queue a terminal notification. Failures stay in this module. */
export function scheduleBridgeMcpFinished(jobId: number): void {
  chain = chain.then(async () => {
    const run = withMcpDb((db) => db.prepare(
      'SELECT run_id FROM bridge_runs WHERE job_id = ? AND direction = \'inbound\'',
    ).get(jobId) as { run_id: string } | undefined)
    if (!run) return
    await deliverFinishedRun(run.run_id)
  }).catch((err) => {
    log.warn({ event: 'bridge-mcp.schedule_failed', jobId, err: err instanceof Error ? err.message : 'schedule' },
      'mcp finished event was not delivered')
  })
}

export function flushBridgeMcpDeliveries(): Promise<void> {
  return chain
}

/** Test hook so a local HTTPS server can satisfy the public-host check. */
export function setMcpPostOptionsForTests(opts: McpPostOptions | null): void {
  testPostOpts = opts
}
