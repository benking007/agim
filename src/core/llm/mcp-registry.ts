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
}

function freshState(): RegistryState {
  return {
    clients: new Map(),
    unhealthy: new Map(),
    toolsByCallName: new Map(),
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
  if (!client?.isConnected()) {
    return {
      text: `MCP server "${entry.server}" not connected (was it shut down or never connected at startup?)`,
      isError: true,
    }
  }
  return client.callTool(callName, args, opts)
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
