// agim-rpc-server — local RPC bridge for bgjob-spawned subprocesses.
//
// Why this exists (v1.2.97, borrowed from Hermes Agent's "Python script
// via RPC" pattern):
//   When `native` faces a task that requires many similar tool calls
//   (e.g. "fetch financial data for 50 stocks, write the result to a
//   CSV, then email me"), running 50 mcp__agim__* calls in a chat turn
//   means 50 LLM round-trips and a real chance of hitting either the
//   stuck-loop detector (v1.2.95) or the iteration cap. The right shape
//   for that work is: the model writes ONE Python script, that script
//   runs in a bgjob detached worker, and the worker calls back into
//   agim's tool surface via local IPC. agim pays one round-trip
//   instead of fifty.
//
// Surface (just enough):
//   - POST   {socket}/rpc/<toolName>
//   - Header X-Agim-Rpc-Token: <hex>
//   - Body   { args: Record<string, unknown> }
//   - Reply  { ok: true, result } | { ok: false, error, status }
//
// Security model:
//   - Unix-domain socket only (no TCP port; cannot be reached from a
//     different host). File mode 0600 owned by the agim process user.
//   - Per-process auth token, minted on demand and bound to a single
//     RunContext (platform / channelId / threadId / userId). A subprocess
//     that knows the token can ONLY drive that one IM thread — it
//     cannot spam push_message into someone else's thread.
//   - Tool whitelist hard-coded to read-only / write-safe agim MCP
//     tools. Operators can extend via AGIM_RPC_ALLOWED_TOOLS env.
//     native_exec / fs writes / call_agent / long_task are NOT exposed
//     — the bgjob worker already has a shell, no need to indirect.
//
// Limits intentionally NOT in MVP:
//   - Per-token rate limit (TODO when first noisy bgjob shows up)
//   - Per-token cost budget for save_memo / push_message
//   - Windows named-pipe alternative (no Windows production targets)

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logger as rootLogger } from '../logger.js'
import { AGIM_HOME } from '../agim-paths.js'
import { handleMemoOp } from '../memo-rpc.js'
import { handlePushOp } from '../push-rpc.js'
import { handleSkillsOp } from '../skills-rpc.js'

const log = rootLogger.child({ component: 'agim-rpc' })

export interface RpcContext {
  platform: string
  channelId: string
  threadId: string
  userId: string
}

interface TokenEntry {
  ctx: RpcContext
  /** ms-epoch expiry. After this time the token is rejected. */
  expiresAt: number
  /** Where the token was minted from — purely for diagnostic logs. */
  origin: string
}

const tokens = new Map<string, TokenEntry>()

const DEFAULT_TTL_MS = (() => {
  const raw = process.env.AGIM_RPC_TOKEN_TTL_MS
  if (!raw) return 24 * 60 * 60 * 1000  // 24 h
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60 * 1000
})()

const DEFAULT_ALLOWED_TOOLS = [
  'mcp__agim__search_memos',
  'mcp__agim__save_memo',
  'mcp__agim__read_skill',
  'mcp__agim__list_skills',
  'mcp__agim__push_message',
]

function resolveAllowedTools(): Set<string> {
  const raw = process.env.AGIM_RPC_ALLOWED_TOOLS
  if (!raw?.trim()) return new Set(DEFAULT_ALLOWED_TOOLS)
  const extra = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return new Set([...DEFAULT_ALLOWED_TOOLS, ...extra])
}

/**
 * Mint a new RPC token bound to a specific IM thread. Returns the hex
 * token + the socket path subprocesses should connect to. Callers
 * should pass these to spawn() via env so the child inherits them
 * unconditionally (and not via argv — argv shows up in `ps`).
 */
export function mintRpcToken(ctx: RpcContext, origin = 'native_exec'): { token: string; socketPath: string; expiresAt: number } {
  const token = randomBytes(32).toString('hex')
  const expiresAt = Date.now() + DEFAULT_TTL_MS
  tokens.set(token, { ctx, expiresAt, origin })
  return { token, socketPath: resolveSocketPath(), expiresAt }
}

/** Revoke a token explicitly. Token registry is also pruned on a
 *  periodic sweep, so revoke is best-effort cleanup, not required. */
export function revokeRpcToken(token: string): void {
  tokens.delete(token)
}

function pruneExpired(): void {
  const now = Date.now()
  for (const [t, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(t)
  }
}

export function resolveSocketPath(): string {
  return process.env.AGIM_RPC_SOCKET || join(AGIM_HOME, 'rpc.sock')
}

let server: Server | null = null
let sweepTimer: NodeJS.Timeout | null = null

/**
 * Start the local RPC server on a Unix socket. Idempotent — repeated
 * calls return the same handle. Best-effort: a failure to start (e.g.
 * permission denied on the socket path) logs at warn and resolves to
 * `null` so the rest of agim boots normally.
 */
export async function startRpcServer(): Promise<Server | null> {
  if (server) return server
  const socketPath = resolveSocketPath()
  try {
    // Make sure the parent dir exists. AGIM_HOME may not have been
    // created yet on a brand-new install.
    await mkdir(dirname(socketPath), { recursive: true })
    // Stale socket from a previous run blocks listen() with EADDRINUSE.
    if (existsSync(socketPath)) {
      try { await unlink(socketPath) } catch { /* best-effort */ }
    }
    const s = createHttpServer((req, res) => { void handleRequest(req, res) })
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(socketPath, () => resolve())
    })
    // Lock the socket down so only the owning UID can connect. Group
    // and world read are intentionally stripped.
    try { await chmod(socketPath, 0o600) } catch { /* best-effort */ }
    server = s
    sweepTimer = setInterval(pruneExpired, 60_000)
    if (sweepTimer.unref) sweepTimer.unref()
    log.info({ event: 'agim-rpc.started', socketPath }, `agim RPC server listening on ${socketPath}`)
    return s
  } catch (err) {
    log.warn({
      event: 'agim-rpc.start_failed',
      socketPath,
      err: err instanceof Error ? err.message : String(err),
    }, 'agim RPC server failed to start — Python sidecar will be unavailable')
    return null
  }
}

/** Graceful shutdown — called on SIGTERM. */
export async function stopRpcServer(): Promise<void> {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
  const activeServer = server
  if (!activeServer) return
  await new Promise<void>((resolve) => activeServer.close(() => resolve()))
  server = null
  try { await unlink(resolveSocketPath()) } catch { /* best-effort */ }
  tokens.clear()
}

async function readBody(req: IncomingMessage, capBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > capBytes) {
        req.destroy()
        reject(new Error(`request body exceeds ${capBytes} bytes`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'POST required', status: 405 })
      return
    }
    const url = req.url || ''
    if (!url.startsWith('/rpc/')) {
      writeJson(res, 404, { ok: false, error: 'unknown route', status: 404 })
      return
    }
    const toolName = url.slice('/rpc/'.length).split(/[?#]/)[0]
    const allowed = resolveAllowedTools()
    if (!allowed.has(toolName)) {
      log.warn({ event: 'agim-rpc.tool_denied', toolName })
      writeJson(res, 403, { ok: false, error: `tool not in RPC whitelist: ${toolName}`, status: 403 })
      return
    }
    const token = String(req.headers['x-agim-rpc-token'] ?? '')
    if (!token) {
      writeJson(res, 401, { ok: false, error: 'missing X-Agim-Rpc-Token header', status: 401 })
      return
    }
    const entry = tokens.get(token)
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) tokens.delete(token)  // expired
      log.warn({ event: 'agim-rpc.token_invalid', toolName, hasEntry: !!entry })
      writeJson(res, 401, { ok: false, error: 'invalid or expired token', status: 401 })
      return
    }
    const raw = await readBody(req)
    let parsed: { args?: Record<string, unknown> }
    try {
      parsed = raw ? JSON.parse(raw) : {}
    } catch {
      writeJson(res, 400, { ok: false, error: 'malformed JSON body', status: 400 })
      return
    }
    const args = (parsed.args ?? {}) as Record<string, unknown>

    log.info({
      event: 'agim-rpc.call',
      toolName,
      origin: entry.origin,
      platform: entry.ctx.platform,
      threadId: entry.ctx.threadId,
    })

    const result = await dispatch(toolName, args, entry.ctx)
    writeJson(res, 200, result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ event: 'agim-rpc.handler_threw', err: msg })
    writeJson(res, 500, { ok: false, error: msg, status: 500 })
  }
}

async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  ctx: RpcContext,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  // Each branch funnels into the SAME RPC handler the in-process
  // native dispatcher uses, so the surface is byte-identical.
  switch (toolName) {
    case 'mcp__agim__search_memos': {
      const r = await handleMemoOp('search', args, ctx)
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error }
    }
    case 'mcp__agim__save_memo': {
      const r = await handleMemoOp('save', args, ctx)
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error }
    }
    case 'mcp__agim__read_skill': {
      const r = await handleSkillsOp({ op: 'read', name: typeof args.name === 'string' ? args.name : '' })
      if (!r.ok) return { ok: false, error: r.error }
      if (r.result.op !== 'read') return { ok: false, error: 'unexpected response shape' }
      if (!r.result.available) return { ok: false, error: `skill unavailable: ${r.result.unavailableReason || 'unknown'}` }
      return { ok: true, result: r.result.body }
    }
    case 'mcp__agim__list_skills': {
      const r = await handleSkillsOp({ op: 'list' })
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error }
    }
    case 'mcp__agim__push_message': {
      const r = await handlePushOp(args as { text?: unknown; toThread?: unknown; kind?: unknown }, ctx)
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error }
    }
    default:
      // Whitelist already filtered upstream; this branch is dead unless
      // an operator added a tool to AGIM_RPC_ALLOWED_TOOLS without
      // adding a corresponding handler here.
      return { ok: false, error: `no handler wired for ${toolName} (operator-extended allowlist?)` }
  }
}

/** Internal-only — used by tests to snapshot token state. */
export function _peekTokensForTests(): Map<string, TokenEntry> {
  return tokens
}
