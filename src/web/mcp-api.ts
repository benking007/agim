// mcp-api — web REST surface for the Stage 6 MCP-servers configuration
// UX. Mirrors `/api/llm/*` shape; the operator can list, add, remove
// external MCP servers and probe their health from the web console
// without hand-editing `~/.agim/config.json`.
//
// Endpoints exposed:
//
//   GET    /api/mcp                           → { servers, connected }
//   POST   /api/mcp/servers                   body { name, command|url, args?, headers?, ... }
//                                              → 201 / 400 validation / 409 conflict
//   DELETE /api/mcp/servers/:name             → 200 OK
//   POST   /api/mcp/servers/:name/health      → 200 { connected, toolCount, lastError? }
//                                              (re-probes by calling listAvailableTools)
//   POST   /api/mcp/reload                    → 200 { connected: number } — reload from config.json
//                                              and reconnect all (used after manual JSON edits)
//
// All write paths run the merged config through configSchema BEFORE
// touching disk — same safety net as `/api/llm/*`.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { AGIM_HOME } from '../core/agim-paths.js'
import { configSchema } from '../core/config-schema.js'
import {
  loadFromConfig as loadMcpFromConfig,
  connectAll as connectAllMcp,
  describeRegistry as describeMcpRegistry,
} from '../core/llm/mcp-registry.js'

const CONFIG_FILE = join(AGIM_HOME, 'config.json')

interface RawMcpServer {
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

interface RawConfig {
  mcpServers?: RawMcpServer[]
  [k: string]: unknown
}

// ─── HTTP helpers (tiny, no shared mock-friendly base needed) ────────

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw.trim()) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// ─── routing ────────────────────────────────────────────────────────

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served (caller should stop walking its own route table); `false`
 * when the URL/method didn't match.
 */
export async function handleMcpApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/mcp' && m === 'GET') {
    await handleList(res); return true
  }
  if (p === '/api/mcp/servers' && m === 'POST') {
    await handleAddServer(req, res); return true
  }
  if (p === '/api/mcp/reload' && m === 'POST') {
    await handleReload(res); return true
  }
  const removeMatch = p.match(/^\/api\/mcp\/servers\/([A-Za-z0-9._-]+)$/)
  if (removeMatch && m === 'DELETE') {
    await handleRemoveServer(res, removeMatch[1]); return true
  }
  const healthMatch = p.match(/^\/api\/mcp\/servers\/([A-Za-z0-9._-]+)\/health$/)
  if (healthMatch && m === 'POST') {
    await handleHealth(res, healthMatch[1]); return true
  }
  return false
}

// ─── handlers ───────────────────────────────────────────────────────

async function handleList(res: ServerResponse): Promise<void> {
  const cfg = await readConfig()
  const servers = (cfg.mcpServers ?? []).map((s) => sanitizeServer(s))
  // Best-effort runtime status — empty when the registry hasn't been
  // loaded (agim daemon may not have called loadMcpFromConfig yet).
  let snap: ReturnType<typeof describeMcpRegistry> = { servers: [], totalTools: 0 }
  try { snap = describeMcpRegistry() } catch { /* registry not initialized */ }
  send(res, 200, { servers, runtime: snap })
}

async function handleAddServer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<RawMcpServer>(req)
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'request body must be a JSON object' })
    return
  }
  const cfg = await readConfig()
  const existing = cfg.mcpServers ?? []
  if (existing.some((s) => s.name === body.name)) {
    send(res, 409, { error: `mcp server "${body.name}" already exists` })
    return
  }
  cfg.mcpServers = [...existing, body]
  // Validate via configSchema before writing — same gate the CLI uses.
  // mcpServerSchema's superRefine catches the "neither command nor url"
  // and "both set" cases with a readable issue string.
  const parsed = configSchema.safeParse(cfg)
  if (!parsed.success) {
    send(res, 400, {
      error: 'config validation failed',
      issues: parsed.error.issues.map((i) => i.message),
    })
    return
  }
  await writeConfig(cfg)
  send(res, 201, { name: body.name })
}

async function handleRemoveServer(res: ServerResponse, name: string): Promise<void> {
  const cfg = await readConfig()
  const servers = cfg.mcpServers ?? []
  const next = servers.filter((s) => s.name !== name)
  if (next.length === servers.length) {
    send(res, 404, { error: `no mcp server named "${name}"` })
    return
  }
  cfg.mcpServers = next
  await writeConfig(cfg)
  send(res, 200, { name })
}

/**
 * Re-probe an existing server: reload registry from on-disk config,
 * connect, return the per-server status. Cheap enough to do
 * synchronously per UI button-press; the actual reconnect can take a
 * second or two for stdio servers spawning subprocesses.
 */
async function handleHealth(res: ServerResponse, name: string): Promise<void> {
  const cfg = await readConfig()
  if (!(cfg.mcpServers ?? []).some((s) => s.name === name)) {
    send(res, 404, { error: `no mcp server named "${name}"` })
    return
  }
  try {
    loadMcpFromConfig(cfg)
    await connectAllMcp()
    const snap = describeMcpRegistry()
    const row = snap.servers.find((r) => r.name === name)
    if (!row) {
      send(res, 200, { name, connected: false, toolCount: 0, lastError: 'server not registered after reload' })
      return
    }
    send(res, 200, {
      name,
      connected: row.connected,
      toolCount: row.toolCount,
      ...(row.error ? { lastError: row.error } : {}),
    })
  } catch (err) {
    send(res, 200, {
      name, connected: false, toolCount: 0,
      lastError: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleReload(res: ServerResponse): Promise<void> {
  const cfg = await readConfig()
  loadMcpFromConfig(cfg)
  const r = await connectAllMcp()
  send(res, 200, {
    requested: r.ok.length + Object.keys(r.failed).length,
    connected: r.ok.length,
    failed: r.failed,
    toolCount: r.toolCount,
  })
}

// ─── helpers ────────────────────────────────────────────────────────

/** Strip nothing — mcp configs don't contain secrets the way LLM ones
 *  do. Operator-supplied headers MAY contain bearer tokens; for now
 *  we surface them as-is in the API response. SECURITY: the /api/mcp
 *  GET is gated by requireAdmin upstream (see server.ts), so this is
 *  admin-only data. If we later add operator-scoped read-only views,
 *  this is where we'd mask `headers.Authorization`. */
function sanitizeServer(s: RawMcpServer): RawMcpServer {
  return s
}

async function readConfig(): Promise<RawConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8')
    return JSON.parse(raw) as RawConfig
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function writeConfig(cfg: RawConfig): Promise<void> {
  await mkdir(AGIM_HOME, { recursive: true, mode: 0o700 })
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { await chmod(CONFIG_FILE, 0o600) } catch { /* ignore on Windows */ }
}
