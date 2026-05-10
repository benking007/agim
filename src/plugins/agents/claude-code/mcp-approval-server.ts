// MCP sidecar — Claude Code 通过 --permission-prompt-tool 调用本进程的 `request` 工具，
// 本进程把请求转发给 im-hub 主进程的 approval-bus（unix socket），等用户决策回包后
// 翻译成 MCP tool result。
//
// 这是个独立进程，由 claude 子进程通过 --mcp-config 启动；与 im-hub 通信只走 socket。
// 启动需要两个 env：
//   IMHUB_APPROVAL_SOCK  unix socket 路径
//   IMHUB_RUN_ID         本次 claude run 的 ID（与 approvalBus.registerRun 配套）
//
// 协议见 src/core/approval-bus.ts。
//
// 入口（编译后）：node dist/plugins/agents/claude-code/mcp-approval-server.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'

const SERVER_NAME = 'imhub'
const TOOL_NAME = 'request'

interface DecisionAllow { behavior: 'allow'; updatedInput?: Record<string, unknown> }
interface DecisionDeny { behavior: 'deny'; message?: string }
type Decision = DecisionAllow | DecisionDeny

interface PendingRequest {
  resolve: (d: Decision) => void
  /** Original tool input — needed to echo back as updatedInput on allow,
   *  since Claude Code rejects an allow response that lacks updatedInput. */
  originalInput: Record<string, unknown>
}

interface ReminderResult {
  ok: boolean
  result?: unknown
  error?: string
}

interface PendingReminderRpc {
  resolve: (r: ReminderResult) => void
}

// Location RPC mirrors reminder RPC — same shape, separate result map so
// reminder + location can be in flight concurrently without reqId collision
// risk (in practice reqIds are UUIDs, but keeping channels separate is
// simpler than reasoning about the shared map).
type LocationResult = ReminderResult
type PendingLocationRpc = PendingReminderRpc

class ApprovalClient {
  private socket: Socket | null = null
  private buf = ''
  private pending = new Map<string, PendingRequest>()
  private pendingReminders = new Map<string, PendingReminderRpc>()
  private pendingLocations = new Map<string, PendingLocationRpc>()
  private connectErr: Error | null = null
  private closed = false
  private connectPromise: Promise<void>

  constructor(private readonly socketPath: string, private readonly runId: string) {
    this.connectPromise = this.connect()
  }

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const sock = createConnection(this.socketPath)
      sock.setEncoding('utf8')

      const onConnectError = (err: Error): void => {
        this.connectErr = err
        this.closed = true
        // stderr surfaces inside Claude Code's MCP log
        process.stderr.write(`[mcp-approval-server] connect failed: ${err.message}\n`)
        resolve()
      }
      sock.once('error', onConnectError)
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError)
        sock.on('error', (err) => {
          process.stderr.write(`[mcp-approval-server] socket error: ${err.message}\n`)
        })
        sock.on('data', (chunk: string) => this.onData(chunk))
        sock.on('close', () => this.onClose())
        this.socket = sock
        resolve()
      })
    })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    while (true) {
      const nl = this.buf.indexOf('\n')
      if (nl === -1) break
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: unknown
      try { msg = JSON.parse(line) } catch {
        process.stderr.write(`[mcp-approval-server] bad json from bus: ${line.slice(0, 200)}\n`)
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>
    if (m.v !== 1) return

    if (m.type === 'decision') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pending.get(reqId)
      if (!p) return
      this.pending.delete(reqId)
      if (m.behavior === 'allow') {
        const updatedInput = (m.updatedInput && typeof m.updatedInput === 'object' && !Array.isArray(m.updatedInput))
          ? m.updatedInput as Record<string, unknown>
          : p.originalInput   // Claude Code requires updatedInput; echo original
        p.resolve({ behavior: 'allow', updatedInput })
      } else {
        const message = typeof m.message === 'string' ? m.message : undefined
        p.resolve({ behavior: 'deny', ...(message ? { message } : {}) })
      }
      return
    }

    if (m.type === 'reminder.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingReminders.get(reqId)
      if (!p) return
      this.pendingReminders.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }

    if (m.type === 'location.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingLocations.get(reqId)
      if (!p) return
      this.pendingLocations.delete(reqId)
      const ok = m.ok === true
      if (ok) {
        p.resolve({ ok: true, result: m.result })
      } else {
        const error = typeof m.error === 'string' ? m.error : 'unknown error'
        p.resolve({ ok: false, error })
      }
      return
    }
  }

  private onClose(): void {
    this.closed = true
    // Drain pending with deny — claude is left hanging otherwise
    for (const [, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'approval bus disconnected' })
    }
    this.pending.clear()
    for (const [, p] of this.pendingReminders) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingReminders.clear()
    for (const [, p] of this.pendingLocations) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingLocations.clear()
  }

  // request(): see below — request → register pending → write payload

  /**
   * Send an approval request and wait for the decision. If the bus is
   * unreachable or the connection has dropped, returns a deny synchronously.
   */
  async request(args: {
    toolName: string
    input: Record<string, unknown>
    toolUseId: string
  }): Promise<Decision> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { behavior: 'deny', message: `approval bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const payload = `${JSON.stringify({
      v: 1,
      type: 'approval',
      runId: this.runId,
      reqId,
      toolName: args.toolName,
      input: args.input,
      toolUseId: args.toolUseId,
    })}\n`

    return new Promise<Decision>((resolve) => {
      this.pending.set(reqId, { resolve, originalInput: args.input })
      this.socket?.write(payload, (err) => {
        if (err) {
          this.pending.delete(reqId)
          resolve({ behavior: 'deny', message: `write failed: ${err.message}` })
        }
      })
    })
  }

  /**
   * Send a reminder RPC and wait for the result. Same socket as approvals,
   * different message type. Bus delegates to reminder-rpc.ts which actually
   * touches reminders.db.
   */
  async requestReminder(op: string, payload: Record<string, unknown>): Promise<ReminderResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'reminder',
      runId: this.runId,
      reqId,
      op,
      payload,
    })}\n`
    return new Promise<ReminderResult>((resolve) => {
      this.pendingReminders.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingReminders.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  /** Same shape as requestReminder, different message type. Bus delegates
   *  to location-rpc.ts which actually writes locations.db. */
  async requestLocation(op: string, payload: Record<string, unknown>): Promise<LocationResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'location',
      runId: this.runId,
      reqId,
      op,
      payload,
    })}\n`
    return new Promise<LocationResult>((resolve) => {
      this.pendingLocations.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingLocations.delete(reqId)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.socket && !this.socket.destroyed) {
      await new Promise<void>((resolve) => {
        this.socket?.once('close', () => resolve())
        this.socket?.end()
        setTimeout(() => { if (this.socket && !this.socket.destroyed) this.socket.destroy() }, 200).unref()
      })
    }
  }
}

/**
 * Build the MCP server. Exposed as a function (rather than top-level `await`)
 * so tests can construct it without spinning up stdio.
 */
export function buildServer(client: ApprovalClient): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '0.1.0',
  })

  // Accept both snake_case (what Claude Code sends over the wire) and
  // camelCase (defensive — some forks normalize). passthrough so unknown
  // future fields are not stripped before we see them.
  const inputSchema = {
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    tool_use_id: z.string().optional(),
    toolUseId: z.string().optional(),
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: 'IM hub permission prompt',
      description:
        'Routes Claude Code permission prompts to im-hub for human approval over IM. ' +
        'Returns {behavior: "allow"|"deny", ...} as a JSON-encoded text block.',
      inputSchema,
    },
    async (args) => {
      const toolName = args.tool_name ?? args.toolName ?? '<unknown>'
      const input = (args.input ?? {}) as Record<string, unknown>
      const toolUseId = args.tool_use_id ?? args.toolUseId ?? ''

      // Auto-allow im-hub's own MCP tools. These are user-scoped, idempotent,
      // and easily reversible via /remind cancel — asking the user to
      // approve "do you really want this reminder you literally just asked
      // for" is double-confirmation and clutters the chat. The tool body
      // itself runs through bus.handleReminder which validates payloads.
      if (toolName.startsWith('mcp__imhub__')) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ behavior: 'allow', updatedInput: input }),
            },
          ],
        }
      }

      const decision = await client.request({ toolName, input, toolUseId })
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(decision) },
        ],
      }
    },
  )

  // ─── Reminder tools ───────────────────────────────────────────────
  // These let Claude create / list / cancel / snooze reminders for the
  // current IM user without going back to the user with a slash command.
  // Bus uses runId → RunContext to know which user/thread the call belongs
  // to. All four tools return JSON-encoded text blocks; the result schema
  // is `{ok: true, result: {...}} | {ok: false, error: string}`.
  //
  // `_im_context` is a single-user fallback for adapter setups where the
  // MCP server is shared (e.g. opencode http daemon — see ensure-mcp-config.ts):
  // the runId env var was set when opencode serve started and is the SAME
  // for all sessions, so we can't disambiguate via runId. Instead the agent
  // is instructed (via prompt injection) to pass an `_im_context` block,
  // which the bus uses iff the runId lookup fails. Untrusted in multi-user
  // deployments — operators must understand the trust model.

  const imContextSchema = z.object({
    platform: z.string(),
    threadId: z.string(),
    channelId: z.string(),
    userId: z.string().optional(),
  }).optional().describe(
    'IM context override. Only set this when the system prompt explicitly tells you to. ' +
    'Otherwise omit and the server figures it out via runId.',
  )

  const wrapReminder = (op: string) => async (args: Record<string, unknown>) => {
    const result = await client.requestReminder(op, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  }
  const wrapLocation = (op: string) => async (args: Record<string, unknown>) => {
    const result = await client.requestLocation(op, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  }

  server.registerTool(
    'create_reminder',
    {
      title: 'Create a reminder',
      description:
        'Create a one-shot or recurring reminder for the current user. CALL THIS PROACTIVELY ' +
        'whenever the user mentions a future commitment, event, task, or anything they might ' +
        'want to be reminded about — including casual mentions like "明天中午要开会", ' +
        '"下周三去医院复查", or explicit asks like "提醒我30分钟后喝水". ' +
        'The reminder will fire at fireAt and be delivered to this same IM thread. ' +
        'After creating, briefly acknowledge to the user (e.g. "✅ 已为你设了提醒，明天12点 团队聚餐"). ' +
        'For recurring: use "every:5m", "daily:08:00", or "weekly:1,3,5:09:00". ' +
        'High-frequency (interval < 1h) + LLM polish is auto-confirmed via card; ' +
        'agent should keep its reply terse in that case.',
      inputSchema: {
        fireAt: z.string().describe('First fire time as ISO 8601 local-time, e.g. "2026-05-10T12:00:00"'),
        text: z.string().describe('What to remind the user about, ≤ 60 chars. Just the activity, not the time.'),
        recurrence: z.string().optional().describe('Optional. "every:5m" | "daily:HH:MM" | "weekly:1,3,5:HH:MM"'),
        promptMode: z.enum(['literal', 'llm']).optional().describe(
          'Default "llm" (LLM polishes the reminder text at fire time). Pass "literal" for verbatim delivery.',
        ),
        _im_context: imContextSchema,
      },
    },
    wrapReminder('create'),
  )

  server.registerTool(
    'list_reminders',
    {
      title: 'List reminders',
      description:
        'List the current user\'s pending reminders. Use this when the user asks "我有什么提醒" / ' +
        '"接下来要做什么" or before suggesting cancel/snooze.',
      inputSchema: { _im_context: imContextSchema },
    },
    wrapReminder('list'),
  )

  server.registerTool(
    'cancel_reminder',
    {
      title: 'Cancel a reminder',
      description:
        'Cancel a pending reminder by id. Find ids via list_reminders. For recurring reminders, ' +
        'this terminates the entire loop.',
      inputSchema: {
        id: z.number().int().positive().describe('Reminder id from list_reminders'),
        _im_context: imContextSchema,
      },
    },
    wrapReminder('cancel'),
  )

  server.registerTool(
    'snooze_reminder',
    {
      title: 'Snooze a reminder',
      description:
        'Push a reminder back by a duration ("5m", "30m", "2h"). Creates a new reminder with the ' +
        'same text and cancels the original.',
      inputSchema: {
        id: z.number().int().positive().describe('Reminder id to snooze'),
        duration: z.string().describe('Duration like "5m" / "30m" / "2h" / "1d"'),
        _im_context: imContextSchema,
      },
    },
    wrapReminder('snooze'),
  )

  // ─── Location tools ─────────────────────────────────────────────────
  // Geo-memo capture and recall. Two record paths + list + delete:
  //
  //   request_location_capture   → returns a one-time HTTPS URL the agent
  //                                surfaces to the user; the user's tap
  //                                triggers a browser geolocation
  //                                permission prompt and POSTs coords back.
  //                                Result delivery is asynchronous —
  //                                im-hub pushes "✅ 已记录" directly to
  //                                the IM thread once coords arrive.
  //
  //   save_location              → store coords (or geocode an address)
  //                                directly. Use this when the agent has
  //                                lat/lng or a full address text.
  //
  //   list_locations             → recent or query-matched memos.
  //
  //   delete_location            → drop one memo.

  server.registerTool(
    'request_location_capture',
    {
      title: 'Request the user\'s current device location',
      description:
        'Generate a one-time HTTPS link that opens a page asking the user\'s browser for ' +
        'their current GPS coordinates. CALL THIS PROACTIVELY when the user wants to record ' +
        'where they ARE RIGHT NOW (parking the car, marking a meeting spot, etc.) and you ' +
        'don\'t already have explicit coordinates from them. Examples that should trigger ' +
        'this: "帮我记下我的车停在这" / "我把伞放这了，记一下" / "记一下我现在的位置". ' +
        'Returns { url, expiresAt, ttlSeconds, note }. Reply to the user with a short ' +
        'sentence + the URL on its own line. After the user taps the link and grants ' +
        'permission, im-hub pushes a "✅ 已记录..." confirmation to this thread directly — ' +
        'you do NOT need to wait for it. The link is single-use and expires in 10 minutes.',
      inputSchema: {
        note: z.string().optional().describe(
          'Optional short label for what is being recorded (e.g. "车", "伞", "停车场B区"). ' +
          'Shown to the user on the H5 page and stored as the memo label. ≤80 chars.',
        ),
        _im_context: imContextSchema,
      },
    },
    wrapLocation('request_capture'),
  )

  server.registerTool(
    'save_location',
    {
      title: 'Save a known location directly',
      description:
        'Persist a location memo without an H5 round-trip. Use when the user GAVE you ' +
        'coordinates ("39.908,116.397") OR a geocodable address ("国贸三期", "Times Square"). ' +
        'Pass either lat+lng (preferred when known) or address (geocoded server-side via ' +
        'Baidu Maps; requires IMHUB_BAIDU_MAP_AK env). Returns { id, lat, lng, label, ' +
        'mapUrl, source }. Confirm to the user with one sentence + the map URL.',
      inputSchema: {
        lat: z.number().min(-90).max(90).optional().describe('Latitude in WGS84 degrees'),
        lng: z.number().min(-180).max(180).optional().describe('Longitude in WGS84 degrees'),
        address: z.string().optional().describe('Free-text address; used if lat/lng absent'),
        note: z.string().optional().describe('Short label / what is being recorded. ≤80 chars'),
        _im_context: imContextSchema,
      },
    },
    wrapLocation('save'),
  )

  server.registerTool(
    'list_locations',
    {
      title: 'List or search location memos',
      description:
        'Look up the user\'s saved location memos. CALL THIS when the user asks where they ' +
        'put / parked / left something, or for any recall query: "我的车在哪", "上次记的咖啡店" ' +
        ', "找下伞的位置". Pass `query` for fuzzy match against label and note (LIKE match, ' +
        'single token). Without `query`, returns the most recent memos. Returns { items: ' +
        '[{ id, lat, lng, label, note, created_at, mapUrl, ... }] }. Format the answer for the ' +
        'user as 1-2 sentences + the map URL on its own line.',
      inputSchema: {
        query: z.string().optional().describe('Fuzzy match against label and note'),
        limit: z.number().int().min(1).max(50).optional().describe('Max rows (default 10)'),
        _im_context: imContextSchema,
      },
    },
    wrapLocation('list'),
  )

  server.registerTool(
    'delete_location',
    {
      title: 'Delete a location memo',
      description:
        'Remove a memo by id. Find ids via list_locations. Use when the user explicitly says ' +
        'to delete / forget / clear a saved location ("删了车的记录" / "把上次那个位置忘掉").',
      inputSchema: {
        id: z.number().int().positive().describe('Memo id from list_locations'),
        _im_context: imContextSchema,
      },
    },
    wrapLocation('delete'),
  )

  return server
}

export { ApprovalClient }

async function main(): Promise<void> {
  const sockPath = process.env.IMHUB_APPROVAL_SOCK
  if (!sockPath) {
    process.stderr.write('[mcp-approval-server] missing IMHUB_APPROVAL_SOCK\n')
    process.exit(1)
  }
  // IMHUB_RUN_ID is optional. Per-spawn paths (claude-code --mcp-config,
  // opencode stdio extraEnv) set a unique runId so the bus can look up
  // the IM thread context. Long-lived shared paths (opencode http daemon
  // spawning the MCP server once at startup) leave it unset; reminder.*
  // tool calls then route via the agent-asserted `_im_context` payload.
  // Approval tool calls without a runId can't be routed and will be
  // denied by the bus — but those paths don't use this sidecar anyway
  // (opencode http does approvals via SSE, not MCP).
  const runId = process.env.IMHUB_RUN_ID || ''

  const client = new ApprovalClient(sockPath, runId)
  const server = buildServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // When stdio closes (claude went away), shut down cleanly.
  const shutdown = async (): Promise<void> => {
    try { await client.close() } catch { /* ignore */ }
    try { await server.close() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// Detect "run as script" — when imported by tests we don't want to spin up stdio.
const isMainModule = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    const url = new URL(import.meta.url)
    return url.pathname.endsWith(process.argv[1].replace(/^.*?(?=\/|$)/, '')) ||
      url.pathname === process.argv[1] ||
      process.argv[1].endsWith('mcp-approval-server.js')
  } catch { return false }
})()

if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`[mcp-approval-server] fatal: ${err}\n`)
    process.exit(1)
  })
}
