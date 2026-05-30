// mcp-registry — owns the McpClient lifecycle (Stage 2 sub-PR #2).
//
// The native agent loop (sub-PR #3) doesn't want to know about
// individual MCP connections. It asks the registry "give me all tools
// I can call" and "run tool X with args Y", and the registry routes
// to the right McpClient by name prefix.
//
// Lifecycle:
//   - `loadFromConfig(cfg)` builds the clients (but does NOT connect)
//   - `connectAll()` runs connect handshakes in parallel; per-server
//     failures are recorded as `unhealthy` rows but don't abort the
//     whole startup (one broken MCP shouldn't take down agim)
//   - `getAllTools()` returns the union of every connected client's
//     ToolDef[]; safe to call before connectAll, just returns empty
//   - `callToolByName(callName, args)` dispatches by the namespaced
//     prefix `mcp_{server}_…`; unknown names return a {error} result
//   - `closeAll()` graceful shutdown, called from cli.ts SIGTERM hook
//
// Module-level singleton (same pattern as llm/registry.ts) — agim is
// single-process so this is safe.

import { logger as rootLogger } from '../logger.js'
import { McpClient, type McpServerConfig, type ToolCallResult } from './mcp-client.js'
import type { ToolDef } from './provider-base.js'

const log = rootLogger.child({ component: 'mcp-registry' })

interface RegistryState {
  clients: Map<string, McpClient>
  unhealthy: Map<string, string>   // server-name -> error message
  toolsByCallName: Map<string, { server: string; tool: ToolDef }>
  /** v1.2.96 — per-server last-reconnect-attempt timestamp (ms epoch).
   *  Used to throttle reconnect attempts when a server is persistently
   *  broken — otherwise a flurry of tool calls would each trigger a
   *  reconnect handshake. */
  lastReconnectAt: Map<string, number>
  /** v1.2.108 — consecutive reconnect failures per server. Resets to 0
   *  on a successful reconnect. Drives exponential backoff so a
   *  permanently-broken server isn't hammered every 5 s forever. */
  reconnectFailures: Map<string, number>
}

function freshState(): RegistryState {
  return {
    clients: new Map(),
    unhealthy: new Map(),
    toolsByCallName: new Map(),
    lastReconnectAt: new Map(),
    reconnectFailures: new Map(),
  }
}

/** v1.2.96 / v1.2.108 — base/cap for the reconnect cooldown. Base is
 *  also what `IMHUB_MCP_RECONNECT_COOLDOWN_MS` used to mean (kept as an
 *  alias for the env name nobody read the docs on). Cap is the max wait
 *  between attempts after the server has failed repeatedly — beyond ~60s
 *  we'd rather let the operator notice than keep silently retrying. */
const RECONNECT_BASE_MS = (() => {
  const raw = process.env.IMHUB_MCP_RECONNECT_BASE_MS ?? process.env.IMHUB_MCP_RECONNECT_COOLDOWN_MS
  if (!raw) return 5_000
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 5_000
})()
const RECONNECT_MAX_MS = (() => {
  const raw = process.env.IMHUB_MCP_RECONNECT_MAX_MS
  if (!raw) return 60_000
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 60_000
})()

/** Exponential backoff for the Nth consecutive reconnect failure. First
 *  attempt (failures=0) waits `base`; each subsequent failure doubles
 *  until `cap`. Exported for unit tests. */
export function computeReconnectCooldownMs(
  failures: number,
  base = RECONNECT_BASE_MS,
  cap = RECONNECT_MAX_MS,
): number {
  if (failures <= 0) return base
  return Math.min(cap, base * Math.pow(2, failures))
}

async function tryReconnect(server: string, client: McpClient): Promise<boolean> {
  const now = Date.now()
  const last = state.lastReconnectAt.get(server) ?? 0
  const failures = state.reconnectFailures.get(server) ?? 0
  const cooldown = computeReconnectCooldownMs(failures)
  if (now - last < cooldown) {
    log.debug({
      event: 'mcp-registry.reconnect_throttled',
      server, msSinceLast: now - last, cooldown, failures,
    })
    return false
  }
  state.lastReconnectAt.set(server, now)
  try {
    // close() is idempotent + no-op when not connected; connect() is
    // guarded by `if (this.client) return`, so we close first to force
    // a fresh handshake.
    await client.close()
    await client.connect()
    state.reconnectFailures.delete(server)  // reset on success
    log.info({ event: 'mcp-registry.reconnected', server })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.reconnectFailures.set(server, failures + 1)
    log.warn({
      event: 'mcp-registry.reconnect_failed',
      server, err: msg, failures: failures + 1, nextCooldownMs: computeReconnectCooldownMs(failures + 1),
    })
    state.unhealthy.set(server, msg)
    return false
  }
}

let state: RegistryState = freshState()

/**
 * Build McpClient instances from config. Idempotent — repeated calls
 * fully replace the previous state (any open connections are closed
 * first via closeAll).
 */
export async function loadFromConfig(cfg: { mcpServers?: unknown }): Promise<void> {
  await closeAll()
  const next = freshState()
  const servers = Array.isArray(cfg.mcpServers) ? (cfg.mcpServers as McpServerConfig[]) : []
  for (const sc of servers) {
    if (!sc || typeof sc !== 'object' || typeof sc.name !== 'string') continue
    if (sc.enabled === false) {
      log.debug({ event: 'mcp-registry.skip_disabled', server: sc.name })
      continue
    }
    if (next.clients.has(sc.name)) {
      log.warn({ event: 'mcp-registry.duplicate', server: sc.name },
        `Duplicate mcpServers entry "${sc.name}"; last wins`)
    }
    next.clients.set(sc.name, new McpClient(sc))
  }
  state = next
  log.info({ event: 'mcp-registry.loaded', servers: state.clients.size })
}

/**
 * Connect every registered client. Failures are recorded in
 * `state.unhealthy` so a broken server doesn't poison the startup
 * sequence. Returns a summary so callers (cli.ts boot log) can print
 * something useful.
 */
export async function connectAll(): Promise<{ ok: string[]; failed: Record<string, string>; toolCount: number }> {
  const ok: string[] = []
  const failed: Record<string, string> = {}
  // Parallel connect — each MCP server is independent. setMaxListeners
  // isn't needed: the SDK uses its own internal abort plumbing.
  await Promise.all(Array.from(state.clients.values()).map(async (client) => {
    try {
      await client.connect()
      const tools = await client.listAvailableTools()
      for (const t of tools) {
        if (state.toolsByCallName.has(t.name)) {
          // Tool name collision across servers — should be impossible
          // given the `mcp_{server}_` prefix, but defend anyway.
          log.warn({ event: 'mcp-registry.tool_name_collision', tool: t.name })
          continue
        }
        state.toolsByCallName.set(t.name, { server: client.name, tool: t })
      }
      ok.push(client.name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      state.unhealthy.set(client.name, msg)
      failed[client.name] = msg
      log.warn({ event: 'mcp-registry.connect_failed', server: client.name, err: msg })
    }
  }))
  return { ok, failed, toolCount: state.toolsByCallName.size }
}

/** All tools across every connected client. Safe to call before
 *  connectAll (returns []). The order is insertion order of the
 *  mcpServers config — useful for the web UI listing. */
export function getAllTools(): ToolDef[] {
  return Array.from(state.toolsByCallName.values()).map((entry) => entry.tool)
}

/** Look up which server owns a given namespaced tool name. */
export function getOwningServer(callName: string): string | null {
  const entry = state.toolsByCallName.get(callName)
  return entry ? entry.server : null
}

/**
 * Dispatch a tool call to the right client. Returns a "tool unknown"
 * error result rather than throwing; the agent loop converts that into
 * a `{role:'tool', isError:true}` message so the model can recover.
 */
export async function callToolByName(
  callName: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolCallResult> {
  const entry = state.toolsByCallName.get(callName)
  if (!entry) {
    return { text: `unknown MCP tool: ${callName}`, isError: true }
  }
  const client = state.clients.get(entry.server)
  if (!client) {
    return {
      text: `MCP server "${entry.server}" not registered`,
      isError: true,
    }
  }
  // v1.2.96 — auto-reconnect on transport drop. Two trigger paths:
  //   (a) we noticed the client wasn't connected before the call →
  //       try to reconnect first (subject to the cooldown).
  //   (b) callTool threw → assume the transport just died and try
  //       once. If reconnect succeeded, retry the call once.
  // Cooldown prevents a flurry of failed calls from each hammering
  // the same broken server with handshakes.
  if (!client.isConnected()) {
    const ok = await tryReconnect(entry.server, client)
    if (!ok) {
      return {
        text: `MCP server "${entry.server}" disconnected and reconnect failed. ` +
          `Operator can restart the server; agim will pick it up on the next tool call.`,
        isError: true,
      }
    }
  }
  try {
    return await client.callTool(callName, args, opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({
      event: 'mcp-registry.tool_call_threw',
      server: entry.server, callName, err: msg,
    }, `MCP tool ${callName} threw; attempting reconnect + retry once`)
    const reconnected = await tryReconnect(entry.server, client)
    if (!reconnected) {
      return { text: `MCP tool failed and reconnect refused: ${msg}`, isError: true }
    }
    try {
      return await client.callTool(callName, args, opts)
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2)
      return { text: `MCP tool failed even after reconnect: ${msg2}`, isError: true }
    }
  }
}

/**
 * Snapshot for cli.ts boot log + future web UI. Reports server count,
 * total advertised tools, and which servers are unhealthy.
 */
export function describeRegistry(): {
  servers: Array<{ name: string; connected: boolean; toolCount: number; error?: string }>
  totalTools: number
} {
  const servers = Array.from(state.clients.values()).map((c) => {
    const tools = Array.from(state.toolsByCallName.values()).filter((e) => e.server === c.name)
    const err = state.unhealthy.get(c.name)
    const entry: { name: string; connected: boolean; toolCount: number; error?: string } = {
      name: c.name,
      connected: c.isConnected(),
      toolCount: tools.length,
    }
    if (err) entry.error = err
    return entry
  })
  return { servers, totalTools: state.toolsByCallName.size }
}

/**
 * Close every client connection. Idempotent — safe to call from
 * graceful shutdown paths even when nothing is connected.
 */
export async function closeAll(): Promise<void> {
  if (state.clients.size === 0) return
  await Promise.all(Array.from(state.clients.values()).map((c) => c.close()))
  state = freshState()
}

/** Test-only: clear without close. Use only in test setups where the
 *  real clients were never instantiated. */
export function _resetRegistry(): void {
  state = freshState()
}
