// mcp-client — thin wrapper over @modelcontextprotocol/sdk for the
// native agent loop (Stage 2 sub-PR #2).
//
// What this file does:
//   - One McpClient per configured server (stdio / sse / streamable-http)
//   - connect(): instantiate the right transport + Client + handshake
//   - listAvailableTools(): discover tools and expose them as agim's
//     ToolDef[] with namespaced names (`mcp_{server}_{tool}`)
//   - callTool(name, args): run a tool by namespaced or original name,
//     return its text result. Wraps the SDK's untyped result in a
//     simpler "text or error" string for the agent loop.
//   - close(): graceful shutdown (used in cli.ts at process exit so we
//     don't leave orphan stdio subprocesses)
//
// What this file deliberately does NOT do (yet):
//   - Resource subscription (server -> client notifications). The
//     agent loop in sub-PR #3 doesn't consume these.
//   - MCP prompts as tools. Useful in nanobot's design but premature
//     until we have a use case here.
//   - Auto-reconnect on transport drop. The SDK does some of this
//     internally; we let the caller (the agent loop) treat connect
//     failures as "tool unavailable for this iteration" via the
//     registry's `unhealthy` flag, then re-probe on subsequent ticks.
//   - Schema normalisation for OpenAI's strict `tools[]` schema. The
//     provider already passes input_schema verbatim; if a server emits
//     an OpenAI-rejected variant (e.g. nullable union via `type: [s,n]`)
//     the openai-compat provider will surface the API error. We can
//     add normalisation later when we hit a real-world server that
//     trips it.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { logger as rootLogger } from '../logger.js'
import type { ToolDef } from './provider-base.js'

const log = rootLogger.child({ component: 'mcp-client' })

const DEFAULT_TOOL_TIMEOUT_MS = 30_000

/**
 * Tool naming policy: `mcp_{server}_{tool}`. Avoids name collisions when
 * two servers advertise the same tool name (common: every server has
 * `read_file`). The original tool name is preserved on `originalName`
 * so error messages stay legible and `enabledTools` filtering can match
 * either form.
 */
export function _namespacedNameForTest(serverName: string, toolName: string): string {
  return namespacedName(serverName, toolName)
}

function namespacedName(serverName: string, toolName: string): string {
  const safeServer = serverName.replace(/[^A-Za-z0-9]+/g, '_')
  const safeTool = toolName.replace(/[^A-Za-z0-9_]+/g, '_')
  return `mcp_${safeServer}_${safeTool}`
}

/** Stage-2 config shape for one MCP server. Mirrors the zod schema in
 *  config-schema.ts but kept here as a plain TS interface so this file
 *  doesn't import the whole schema module just for the type. */
export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolTimeoutMs?: number
  enabledTools?: string[]
  enabled?: boolean
}

/** Result of a single tool call. Stage-2 agent loop treats this as
 *  free-form text appended to the conversation as a tool message. */
export interface ToolCallResult {
  text: string
  isError: boolean
}

/**
 * Wraps one MCP server connection. The caller (`mcp-registry.ts`)
 * holds a Map<server-name, McpClient> and is responsible for lifecycle
 * (connectAll at boot, closeAll on shutdown).
 */
export class McpClient {
  readonly name: string
  private readonly cfg: McpServerConfig
  private readonly toolTimeoutMs: number
  private client: Client | null = null
  // Cache the listTools() result so the agent loop doesn't pay the
  // round-trip cost on every iteration. Servers that hot-reload tools
  // mid-session would need an explicit refresh hook; punt until a real
  // case appears.
  private cachedTools: { full: ToolDef[]; byCallName: Map<string, string> } | null = null

  constructor(cfg: McpServerConfig) {
    this.name = cfg.name
    this.cfg = cfg
    this.toolTimeoutMs = cfg.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  }

  /** True once connect() has completed without error. */
  isConnected(): boolean {
    return this.client !== null
  }

  /**
   * Pick the right transport for the config and run the MCP handshake.
   * Errors propagate; registry surfaces them as `unhealthy` rows.
   */
  async connect(): Promise<void> {
    if (this.client) return  // idempotent
    const transport = buildTransport(this.cfg)
    const client = new Client(
      { name: 'agim-mcp-client', version: '1' },
      // capabilities — we don't advertise sampling / roots / elicitation
      // yet; tools-only consumer.
      { capabilities: {} },
    )
    await client.connect(transport)
    this.client = client
    log.info({
      event: 'mcp.connected', server: this.name,
      transport: classifyTransport(this.cfg),
    })
  }

  /**
   * Discover the server's tool roster and project into agim ToolDef[].
   * Applies `enabledTools` filter and the namespaced-name policy.
   */
  async listAvailableTools(): Promise<ToolDef[]> {
    if (!this.client) throw new Error(`mcp-client[${this.name}]: not connected`)
    if (this.cachedTools) return this.cachedTools.full

    const resp = await this.client.listTools({})
    // resp.tools shape per MCP spec: [{name, description?, inputSchema}]
    const filter = this.cfg.enabledTools && this.cfg.enabledTools.length > 0
      && !(this.cfg.enabledTools.length === 1 && this.cfg.enabledTools[0] === '*')
      ? new Set(this.cfg.enabledTools)
      : null

    const out: ToolDef[] = []
    const byCallName = new Map<string, string>()  // namespaced -> original
    for (const t of resp.tools as Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) {
      if (!t?.name) continue
      const namespaced = namespacedName(this.name, t.name)
      if (filter && !filter.has(t.name) && !filter.has(namespaced)) continue
      byCallName.set(namespaced, t.name)
      out.push({
        name: namespaced,
        description: typeof t.description === 'string' ? t.description : '',
        parameters: ensureObjectSchema(t.inputSchema),
      })
    }
    this.cachedTools = { full: out, byCallName }
    log.info({
      event: 'mcp.tools.listed', server: this.name,
      count: out.length, filtered: filter !== null,
    })
    return out
  }

  /**
   * Invoke a tool by either the namespaced or original name. Returns
   * the concatenated text content + an isError flag (the MCP spec
   * lets a tool succeed at the transport level while reporting a
   * domain-level error; the agent loop should usually pass either
   * back to the model so it can react).
   */
  async callTool(callName: string, args: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<ToolCallResult> {
    if (!this.client) throw new Error(`mcp-client[${this.name}]: not connected`)
    const originalName = this._resolveOriginalName(callName)
    if (originalName === null) {
      return { text: `unknown tool: ${callName}`, isError: true }
    }
    const t0 = Date.now()
    try {
      const resp = await this.client.callTool(
        { name: originalName, arguments: args },
        undefined,
        {
          timeout: this.toolTimeoutMs,
          signal: opts.signal,
        },
      )
      const text = aggregateTextContent(resp?.content as unknown)
      const isError = Boolean(resp?.isError)
      log.info({
        event: 'mcp.tool.called',
        server: this.name, tool: originalName,
        elapsedMs: Date.now() - t0,
        bytes: text.length, isError,
      })
      return { text, isError }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn({
        event: 'mcp.tool.failed',
        server: this.name, tool: originalName,
        elapsedMs: Date.now() - t0,
        err: msg,
      })
      return { text: `mcp tool call failed: ${msg}`, isError: true }
    }
  }

  /** Best-effort close. Idempotent. */
  async close(): Promise<void> {
    if (!this.client) return
    try { await this.client.close() } catch { /* ignore */ }
    this.client = null
    this.cachedTools = null
  }

  private _resolveOriginalName(callName: string): string | null {
    if (!this.cachedTools) return null
    // First try namespaced (preferred); fall back to original (handy
    // for human-driven /heartbeat run-now style debugging).
    const mapped = this.cachedTools.byCallName.get(callName)
    if (mapped) return mapped
    for (const orig of this.cachedTools.byCallName.values()) {
      if (orig === callName) return orig
    }
    return null
  }
}

// ─── Transport factory ────────────────────────────────────────────────

function buildTransport(cfg: McpServerConfig) {
  if (cfg.command) {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
      cwd: cfg.cwd,
    })
  }
  if (cfg.url) {
    const u = new URL(cfg.url)
    if (cfg.url.endsWith('/sse')) {
      return new SSEClientTransport(u, cfg.headers ? {
        requestInit: { headers: cfg.headers },
      } : undefined)
    }
    return new StreamableHTTPClientTransport(u, cfg.headers ? {
      requestInit: { headers: cfg.headers },
    } : undefined)
  }
  throw new Error(`mcp-client[${cfg.name}]: must set either command (stdio) or url (http/sse)`)
}

function classifyTransport(cfg: McpServerConfig): 'stdio' | 'sse' | 'streamableHttp' {
  if (cfg.command) return 'stdio'
  if (cfg.url?.endsWith('/sse')) return 'sse'
  return 'streamableHttp'
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Make sure the input schema is at least an object — MCP servers
 *  sometimes return undefined or a non-object for parameterless tools. */
export function _ensureObjectSchemaForTest(raw: unknown): Record<string, unknown> {
  return ensureObjectSchema(raw)
}

function ensureObjectSchema(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return { type: 'object', properties: {} }
}

/**
 * MCP tool results are `content: [{type, text, ...}, ...]`. Concatenate
 * every `text` block into one string for the agent loop. Non-text
 * blocks (image, resource) are stringified as `[image]` etc. so the
 * model at least sees they were there; first-class image support
 * lands when we wire vision providers.
 */
export function _aggregateTextContentForTest(content: unknown): string {
  return aggregateTextContent(content)
}

function aggregateTextContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push(block.text)
    } else if (block.type === 'image') {
      out.push('[image]')
    } else if (block.type === 'resource' || block.type === 'resource_link') {
      out.push('[resource]')
    }
  }
  return out.join('')
}
