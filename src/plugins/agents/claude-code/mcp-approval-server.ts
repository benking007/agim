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
type MemoResult = ReminderResult
type PendingMemoRpc = PendingReminderRpc

class ApprovalClient {
  private socket: Socket | null = null
  private buf = ''
  private pending = new Map<string, PendingRequest>()
  private pendingReminders = new Map<string, PendingReminderRpc>()
  private pendingMemos = new Map<string, PendingMemoRpc>()
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

    if (m.type === 'memo.result') {
      const reqId = typeof m.reqId === 'string' ? m.reqId : null
      if (!reqId) return
      const p = this.pendingMemos.get(reqId)
      if (!p) return
      this.pendingMemos.delete(reqId)
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
    for (const [, p] of this.pendingMemos) {
      p.resolve({ ok: false, error: 'approval bus disconnected' })
    }
    this.pendingMemos.clear()
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
   *  to memo-rpc.ts which actually writes memos.db. */
  async requestMemo(op: string, payload: Record<string, unknown>): Promise<MemoResult> {
    await this.connectPromise
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    const reqId = randomUUID()
    const wire = `${JSON.stringify({
      v: 1,
      type: 'memo',
      runId: this.runId,
      reqId,
      op,
      payload,
    })}\n`
    return new Promise<MemoResult>((resolve) => {
      this.pendingMemos.set(reqId, { resolve })
      this.socket?.write(wire, (err) => {
        if (err) {
          this.pendingMemos.delete(reqId)
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
  const wrapMemo = (op: string) => async (args: Record<string, unknown>) => {
    const result = await client.requestMemo(op, args)
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

  // ─── Memo tools (5W1H persistent memory) ─────────────────────────────
  // Generalized "记下来" memory database. Each memo carries optional 5W1H
  // fields — what (REQUIRED), who, when_at/when_text, where_lat/lng/label,
  // how, why. Plus expires_at (NULL = permanent). Five tools:
  //
  //   save_memo                  agent extracts whatever 5W1H it can from
  //                              the user's natural language and persists.
  //   request_location_capture   one-time HTTPS link for browser GPS;
  //                              creates a NEW memo OR augments an
  //                              existing memo's where_*. Result delivery
  //                              is async — im-hub pushes "✅ 已记下..."
  //                              to the IM thread once coords arrive.
  //   search_memos               recall: free-text + structured filters.
  //   update_memo                patch an existing memo when user adds
  //                              context after the initial save.
  //   delete_memo                drop one memo by id.

  server.registerTool(
    'save_memo',
    {
      title: 'Save a memo (5W1H persistent record)',
      description:
        'Record any kind of memo for the user — "请记下" / "帮我记一下" / "别忘了" / "重要的事". ' +
        'Extract 5W1H from the user\'s message: what (the core thing — REQUIRED), who (person/org), ' +
        'when_at (parseable ISO datetime) or when_text (raw phrase if not parseable), where_lat/lng + ' +
        'where_label OR address (server geocodes), how (manner), why (reason). Examples:\n' +
        '  "我爸爸的生日是5月8日" → { what: "生日", who: "爸爸", when_text: "5月8日" }\n' +
        '  "明天下午3点开会"     → { what: "开会", when_at: "<ISO_FOR_TOMORROW_15:00>" }\n' +
        '  "记一下，伞放在前台"  → { what: "伞", where_label: "前台" }\n' +
        '  "苹果今年发了AVP2"    → { what: "AVP2", who: "苹果" }\n' +
        '  "国贸三期是公司新址"  → { what: "公司新址", address: "国贸三期" } (geocoded)\n\n' +
        'EXPIRY: by default memos persist forever. Set expires_in_hours when the memo describes ' +
        'TRANSIENT state — typical values: 24 (one day), 168 (one week). Trigger words for ' +
        'transient: "暂时" / "临时" / "今天" / "这次" / "刚刚" / parking-style "停在这" — anything ' +
        'where the info would be useless after a day or week. Trigger words for permanent (omit ' +
        'expires_in_hours): "永久" / "记住" / "总是" / 生日 / 联系方式 / preferences. When ' +
        'unsure, ASK the user briefly: "永久记还是 24h 后忘掉？" then use the answer.\n\n' +
        'IF the user wants to record their CURRENT GPS location ("我把车停这" / "记一下我现在 ' +
        '的位置"), DO NOT call save_memo — call request_location_capture instead (it can take a ' +
        '`what` arg to label the new memo at capture time).\n\n' +
        'Returns the saved memo summary including id, fields, and (if where_* set) mapUrls. ' +
        'Confirm to the user with one sentence + the map links using markdown syntax ' +
        '`[百度地图](url) · [高德地图](url) · [Google](url)`. Do NOT print raw URLs.',
      inputSchema: {
        what: z.string().describe('Core thing being recorded (REQUIRED). ≤200 chars'),
        who: z.string().optional().describe('Person/org/role involved (e.g. "爸爸", "团队")'),
        when_at: z.string().optional().describe('ISO 8601 local datetime, e.g. "2026-05-08T15:00:00"'),
        when_text: z.string().optional().describe('Raw user phrase if when_at not parseable, e.g. "明年5月"'),
        where_lat: z.number().min(-90).max(90).optional().describe('WGS-84 latitude (pair with where_lng)'),
        where_lng: z.number().min(-180).max(180).optional().describe('WGS-84 longitude'),
        where_label: z.string().optional().describe('Place name / address text'),
        address: z.string().optional().describe('Free-text address — geocoded server-side via Baidu when where_lat/lng absent'),
        how: z.string().optional().describe('Manner / process'),
        why: z.string().optional().describe('Reason / motivation'),
        expires_in_hours: z.number().positive().optional().describe('Auto-expire in N hours. Omit for permanent.'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('save'),
  )

  server.registerTool(
    'request_location_capture',
    {
      title: 'Get user\'s current device GPS via one-time link',
      description:
        'Generate a one-time HTTPS link that opens a page asking for browser geolocation. ' +
        'CALL THIS when the user wants to record where they ARE RIGHT NOW: "我把车停这了" / ' +
        '"记一下我现在的位置" / "伞放这儿了，记一下". Two modes:\n\n' +
        '  1. Create new memo (pass `what`): the H5 callback creates a fresh memo with ' +
        '     where_lat/lng + the what label. Use when this is the first time the topic is ' +
        '     being captured.\n' +
        '  2. Update existing memo (pass `memo_id`): the callback patches an existing memo\'s ' +
        '     where_* fields. Use after save_memo when you saved the structural info but ' +
        '     still need GPS.\n\n' +
        'Returns { url, expiresAt, ttlSeconds, what?, memoId? }. Reply to the user with ' +
        'markdown link syntax `[👉 点击共享当前位置](url)` on its own line so iLink renders ' +
        'a tappable label (the URL itself stays hidden). Do NOT print the raw URL.\n\n' +
        'After the user taps and grants permission, im-hub pushes a "✅ 已记下..." confirmation ' +
        'to this thread directly — you do NOT need to wait. Link is single-use and expires in ' +
        '10 minutes. EXPIRY for the memo itself is set via save_memo separately if needed; ' +
        'capture-flow memos default to permanent unless you call save_memo first with ' +
        'expires_in_hours then attach via memo_id here.',
      inputSchema: {
        what: z.string().optional().describe('Short label for what is being recorded (e.g. "车", "伞"). Used as the new memo\'s what field. ≤80 chars. Mutually exclusive with memo_id.'),
        memo_id: z.number().int().positive().optional().describe('Existing memo id to augment with GPS instead of creating a new one. Mutually exclusive with what.'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('request_capture'),
  )

  server.registerTool(
    'search_memos',
    {
      title: 'Search the user\'s memos',
      description:
        'Recall memos for ANY query the user makes about their saved knowledge: "我的车在哪" / ' +
        '"我爸爸的生日" / "上周记了什么" / "找下AVP2那条". Combines free-text query with optional ' +
        'structured filters; all filters AND-combine. Empty query returns most recent.\n\n' +
        'Examples:\n' +
        '  "我的车在哪？"        → { query: "车", has_location: true }\n' +
        '  "我爸爸生日是哪天？" → { who: "爸爸", what: "生日" }\n' +
        '  "今天记了什么？"     → { when_after: "<ISO_TODAY_00>" }\n' +
        '  "找下苹果发布会"     → { query: "苹果发布会" }\n\n' +
        'Returns { items: [{ id, what, who, whenAt/whenText, where: { lat, lng, label, mapUrl, ' +
        'mapUrls } if location set, how, why, expiresAt, createdAt }] }. Format the answer ' +
        'naturally for the user: 1-2 sentences summarizing the find + (if where set) all three ' +
        'map URLs using markdown links `[百度地图](url) · [高德地图](url) · [Google](url)`. ' +
        'Do NOT print raw URLs. If multiple matches, lead with the most recent.',
      inputSchema: {
        query: z.string().optional().describe('Free-text — fuzzy LIKE match across what/who/where_label/how/why/when_text'),
        who: z.string().optional().describe('Filter by who field (LIKE match)'),
        what: z.string().optional().describe('Filter by what field (LIKE match)'),
        has_location: z.boolean().optional().describe('When true, only memos with where_lat set'),
        when_after: z.string().optional().describe('ISO datetime — memos with when_at OR created_at >= this'),
        when_before: z.string().optional().describe('ISO datetime — memos with when_at OR created_at <= this'),
        include_expired: z.boolean().optional().describe('Include expired memos in results (default false)'),
        limit: z.number().int().min(1).max(50).optional().describe('Max rows (default 10)'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('search'),
  )

  server.registerTool(
    'update_memo',
    {
      title: 'Patch fields on an existing memo',
      description:
        'Update ANY 5W1H field on an existing memo. CALL THIS when the user adds info to a ' +
        'previously-saved memo: "对了，那个会议在 3 楼 A 区" → update_memo({ id, where_label: ' +
        '"3楼A区" }). Or to extend / shorten the expiry: "把车那条改成永久" → update_memo({ ' +
        'id, expires_at: null }).\n\n' +
        'Pass null to a field to CLEAR it (vs omitting which leaves alone). For expiry, you ' +
        'can pass either expires_in_hours (relative) or expires_at (absolute ISO; null clears).\n\n' +
        'Returns the updated memo summary. Confirm to the user with one sentence.',
      inputSchema: {
        id: z.number().int().positive().describe('Memo id from search_memos'),
        what: z.string().optional(),
        who: z.string().nullable().optional(),
        when_at: z.string().nullable().optional(),
        when_text: z.string().nullable().optional(),
        where_lat: z.number().min(-90).max(90).nullable().optional(),
        where_lng: z.number().min(-180).max(180).nullable().optional(),
        where_label: z.string().nullable().optional(),
        how: z.string().nullable().optional(),
        why: z.string().nullable().optional(),
        expires_in_hours: z.number().positive().optional(),
        expires_at: z.string().nullable().optional().describe('ISO datetime or null to clear'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('update'),
  )

  server.registerTool(
    'delete_memo',
    {
      title: 'Delete a memo by id',
      description:
        'Remove a memo. Find ids via search_memos. Use when user explicitly says to delete / ' +
        'forget / clear ("删了车那条" / "把生日那条记录忘掉"). ⚠️ Permanent — confirm with the ' +
        'user before calling for important-looking memos (no expiry set, who/when fields populated).',
      inputSchema: {
        id: z.number().int().positive().describe('Memo id from search_memos'),
        _im_context: imContextSchema,
      },
    },
    wrapMemo('delete'),
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
