// Agim bridge extension for PI.
//
// PI does not expose MCP, but it can load a TypeScript/JavaScript extension
// and register custom tools. This extension mirrors the Agim MCP tool surface
// by forwarding tool calls to the in-process approval bus over the same NDJSON
// socket used by the Claude Code sidecar.

import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import {
  CALL_AGENTS_TASKS_HARD_MAX,
  getSubagentParallelMax,
  isSubagentParallelEnabled,
  mapPool,
} from '../../../core/subagent-parallel.js'

type JsonObject = Record<string, unknown>

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details?: unknown
  isError?: boolean
}

interface ToolDefinition {
  name: string
  label: string
  description: string
  promptSnippet?: string
  promptGuidelines?: string[]
  parameters: JsonObject
  execute(
    toolCallId: string,
    params: JsonObject,
    signal?: AbortSignal,
    onUpdate?: (update: ToolResult) => void,
  ): Promise<ToolResult>
}

interface PiExtensionApi {
  registerTool(tool: ToolDefinition): void
}

interface PendingRpc {
  resultType: string
  resolve: (value: JsonObject) => void
}

type AgimRpcType = 'skill' | 'memory' | 'memo' | 'reminder' | 'ask' | 'push' | 'a2a' | 'native_tool'

const ANY_OBJECT_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: true,
}

const EMPTY_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const WEB_SEARCH_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Search query.' },
    n: { type: 'number', description: 'Max results. Default 8, hard cap 20.' },
  },
  required: ['query'],
}

const WEB_FETCH_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', description: 'http(s) URL to fetch.' },
    format: {
      type: 'string',
      enum: ['reader', 'raw'],
      description: 'reader returns extracted text; raw returns the response body.',
    },
  },
  required: ['url'],
}

const AGIM_BASH_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', description: 'Shell command to execute in the Agim agent workspace after user approval.' },
    timeout_ms: { type: 'number', description: 'Optional timeout in ms. Default 60000, max 600000.' },
    cwd: { type: 'string', description: 'Optional cwd override. Defaults to the PI Agim workspace.' },
  },
  required: ['command'],
}

const AGIM_WRITE_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'File path to write, relative to the PI Agim workspace unless absolute.' },
    content: { type: 'string', description: 'Full file content.' },
    mode: { type: 'string', enum: ['overwrite', 'append'], description: 'overwrite (default) or append.' },
  },
  required: ['path', 'content'],
}

const AGIM_EDIT_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'File path to edit, relative to the PI Agim workspace unless absolute.' },
    old_string: { type: 'string', description: 'Exact text to replace.' },
    new_string: { type: 'string', description: 'Replacement text.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false; repeated matches require this or more context.' },
  },
  required: ['path', 'old_string', 'new_string'],
}

function textResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  }
}

function unwrappedRpcTextResult(value: JsonObject): ToolResult {
  if (value.ok === false) return textResult(value.error ?? value, true)
  if (Object.hasOwn(value, 'result')) return textResult(value.result)
  return textResult(value)
}

class AgimBusClient {
  private socket: Socket | null = null
  private connectPromise: Promise<void> | null = null
  private connectErr: Error | null = null
  private closed = false
  private buf = ''
  private pending = new Map<string, PendingRpc>()

  constructor(
    private readonly socketPath: string | undefined,
    private readonly runId: string | undefined,
  ) {}

  private async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = new Promise((resolve) => {
      if (!this.socketPath) {
        this.connectErr = new Error('AGIM_APPROVAL_SOCK is not set')
        this.closed = true
        resolve()
        return
      }

      const sock = createConnection(this.socketPath)
      sock.setEncoding('utf8')
      const onConnectError = (err: Error): void => {
        this.connectErr = err
        this.closed = true
        resolve()
      }
      sock.once('error', onConnectError)
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError)
        sock.on('error', (err) => {
          process.stderr.write(`[agim-pi-extension] socket error: ${err.message}\n`)
        })
        sock.on('data', (chunk: string) => this.onData(chunk))
        sock.on('close', () => this.onClose())
        this.socket = sock
        resolve()
      })
    })
    return this.connectPromise
  }

  private onData(chunk: string): void {
    this.buf += chunk
    while (true) {
      const nl = this.buf.indexOf('\n')
      if (nl === -1) break
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        this.dispatch(JSON.parse(line) as JsonObject)
      } catch {
        process.stderr.write(`[agim-pi-extension] bad json from bus: ${line.slice(0, 200)}\n`)
      }
    }
  }

  private dispatch(message: JsonObject): void {
    if (message.v !== 1 || typeof message.reqId !== 'string' || typeof message.type !== 'string') return
    const pending = this.pending.get(message.reqId)
    if (!pending || message.type !== pending.resultType) return
    this.pending.delete(message.reqId)
    pending.resolve(message)
  }

  private onClose(): void {
    this.closed = true
    for (const [reqId, pending] of this.pending.entries()) {
      pending.resolve({ v: 1, type: pending.resultType, reqId, ok: false, error: 'approval bus disconnected' })
    }
    this.pending.clear()
  }

  async request(
    type: AgimRpcType,
    payload: JsonObject,
    opts: { op?: string; signal?: AbortSignal } = {},
  ): Promise<JsonObject> {
    await this.connect()
    if (this.connectErr || this.closed || !this.socket) {
      return { ok: false, error: `bus unavailable: ${this.connectErr?.message ?? 'closed'}` }
    }
    if (type !== 'skill' && !this.runId) {
      return { ok: false, error: 'AGIM_RUN_ID is not set' }
    }

    const reqId = randomUUID()
    const message: JsonObject = { v: 1, type, reqId, payload }
    if (type !== 'skill') message.runId = this.runId
    if (opts.op) message.op = opts.op
    const resultType = `${type}.result`

    return new Promise<JsonObject>((resolve) => {
      const onAbort = (): void => {
        this.pending.delete(reqId)
        resolve({ ok: false, error: 'tool call aborted' })
      }
      if (opts.signal?.aborted) {
        onAbort()
        return
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(reqId, {
        resultType,
        resolve: (value) => {
          opts.signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
      })
      this.socket?.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err) {
          this.pending.delete(reqId)
          opts.signal?.removeEventListener('abort', onAbort)
          resolve({ ok: false, error: `write failed: ${err.message}` })
        }
      })
    })
  }
}

let client: AgimBusClient | null = null

function getClient(): AgimBusClient {
  client ??= new AgimBusClient(process.env.AGIM_APPROVAL_SOCK, process.env.AGIM_RUN_ID)
  return client
}

function registerRpcTool(
  pi: PiExtensionApi,
  spec: {
    name: string
    label: string
    description: string
    type: AgimRpcType
    op?: string
    parameters?: JsonObject
    payload?: (params: JsonObject) => JsonObject
    formatResult?: (value: JsonObject) => ToolResult
  },
): void {
  pi.registerTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.description,
    parameters: spec.parameters ?? ANY_OBJECT_SCHEMA,
    async execute(_toolCallId, params, signal) {
      const payload = spec.payload ? spec.payload(params) : params
      const result = await getClient().request(spec.type, payload, { op: spec.op, signal })
      if (spec.formatResult) return spec.formatResult(result)
      return textResult(result, result.ok === false)
    },
  })
}

export default function agimPiExtension(pi: PiExtensionApi): void {
  registerRpcTool(pi, {
    name: 'mcp__agim__read_skill',
    label: 'Agim read skill',
    description: 'Read the full SKILL.md body for an Agim skill by name.',
    type: 'skill',
    parameters: ANY_OBJECT_SCHEMA,
    payload: (params) => ({ op: 'read', ...params }),
  })
  registerRpcTool(pi, {
    name: 'mcp__agim__list_skills',
    label: 'Agim list skills',
    description: 'List Agim skills available to this conversation.',
    type: 'skill',
    parameters: EMPTY_SCHEMA,
    payload: () => ({ op: 'list' }),
  })
  registerRpcTool(pi, {
    name: 'web_search',
    label: 'Agim web search',
    description: 'Search the web through Agim native web_search. Use it for current information, news, docs, or discovery by keywords.',
    type: 'native_tool',
    parameters: WEB_SEARCH_SCHEMA,
    payload: (params) => ({ name: 'web_search', arguments: params }),
    formatResult: unwrappedRpcTextResult,
  })
  registerRpcTool(pi, {
    name: 'web_fetch',
    label: 'Agim web fetch',
    description: 'Fetch a specific http(s) URL through Agim native web_fetch. Use web_search first when you only have keywords.',
    type: 'native_tool',
    parameters: WEB_FETCH_SCHEMA,
    payload: (params) => ({ name: 'web_fetch', arguments: params }),
    formatResult: unwrappedRpcTextResult,
  })
  registerRpcTool(pi, {
    name: 'agim_bash',
    label: 'Agim bash',
    description: 'Execute a shell command through Agim after user approval. Use this instead of PI native bash so IM users can approve or deny execution.',
    type: 'native_tool',
    parameters: AGIM_BASH_SCHEMA,
    payload: (params) => ({ name: 'agim_bash', arguments: params }),
    formatResult: unwrappedRpcTextResult,
  })
  registerRpcTool(pi, {
    name: 'agim_write',
    label: 'Agim write file',
    description: 'Write or append a file through Agim after user approval. Use this instead of PI native write/edit for IM-controlled sessions.',
    type: 'native_tool',
    parameters: AGIM_WRITE_SCHEMA,
    payload: (params) => ({ name: 'agim_write', arguments: params }),
    formatResult: unwrappedRpcTextResult,
  })
  registerRpcTool(pi, {
    name: 'agim_edit',
    label: 'Agim edit file',
    description: 'Edit a file by exact string replacement through Agim after user approval. Use this instead of PI native edit for IM-controlled sessions.',
    type: 'native_tool',
    parameters: AGIM_EDIT_SCHEMA,
    payload: (params) => ({ name: 'agim_edit', arguments: params }),
    formatResult: unwrappedRpcTextResult,
  })

  for (const [name, op, label, description] of [
    ['mcp__agim__save_memo', 'save', 'Agim save memo', 'Save an explicit user memo or 5W1H note.'],
    ['mcp__agim__search_memos', 'search', 'Agim search memos', 'Search explicit memos saved for the current user.'],
    ['mcp__agim__update_memo', 'update', 'Agim update memo', 'Patch fields on an existing memo.'],
    ['mcp__agim__delete_memo', 'delete', 'Agim delete memo', 'Delete a memo by id.'],
    ['mcp__agim__request_location_capture', 'request_capture', 'Agim request GPS capture', 'Ask the user to share current GPS through a one-time link.'],
  ] as const) {
    registerRpcTool(pi, { name, op, label, description, type: 'memo' })
  }

  for (const [name, op, label, description] of [
    ['mcp__agim__memory_query', 'query', 'Agim memory query', 'Recall long-term facts about the current user.'],
    ['mcp__agim__memory_save', 'save', 'Agim memory save', 'Remember a long-term fact about the current user.'],
    ['mcp__agim__memory_list', 'list', 'Agim memory list', 'List recent long-term facts for the current user.'],
    ['mcp__agim__memory_delete', 'delete', 'Agim memory delete', 'Delete a long-term fact by id.'],
  ] as const) {
    registerRpcTool(pi, { name, op, label, description, type: 'memory' })
  }

  for (const [name, op, label, description] of [
    ['mcp__agim__create_reminder', 'create', 'Agim create reminder', 'Create a one-shot or recurring reminder for the current user.'],
    ['mcp__agim__list_reminders', 'list', 'Agim list reminders', 'List pending reminders for the current user.'],
    ['mcp__agim__cancel_reminder', 'cancel', 'Agim cancel reminder', 'Cancel a reminder by id.'],
    ['mcp__agim__snooze_reminder', 'snooze', 'Agim snooze reminder', 'Snooze a reminder by duration.'],
  ] as const) {
    registerRpcTool(pi, { name, op, label, description, type: 'reminder' })
  }

  registerRpcTool(pi, {
    name: 'mcp__agim__ask_user',
    label: 'Agim ask user',
    description: 'Ask the current IM user a structured multiple-choice question and wait for the answer.',
    type: 'ask',
  })
  registerRpcTool(pi, {
    name: 'mcp__agim__push_message',
    label: 'Agim push message',
    description: 'Push a proactive message to the current IM thread.',
    type: 'push',
  })
  registerRpcTool(pi, {
    name: 'mcp__agim__call_agent',
    label: 'Agim call agent',
    description:
      'Spawn ONE Subagent and wait for its result. For 2+ independent lanes use '
      + 'mcp__agim__call_agents. Loop Engineering (/loop, loop_verdict) stays Agim-only.',
    type: 'a2a',
  })
  pi.registerTool({
    name: 'mcp__agim__call_agents',
    label: 'Agim call agents',
    description:
      'Spawn MULTIPLE Subagents in one call (fan-out / join). Prefer 2–3 independent lanes. '
      + `Hard max ${CALL_AGENTS_TASKS_HARD_MAX} tasks. Loop Engineering stays Agim-only.`,
    promptSnippet: 'Fan-out Subagent dispatch (call_agents).',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: CALL_AGENTS_TASKS_HARD_MAX,
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string' },
              prompt: { type: 'string' },
              timeoutMs: { type: 'number' },
            },
            required: ['agent', 'prompt'],
            additionalProperties: true,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      const raw = Array.isArray(params.tasks) ? params.tasks : []
      if (raw.length === 0) {
        return textResult({ ok: false, error: 'call_agents requires a non-empty `tasks` array.' }, true)
      }
      if (raw.length > CALL_AGENTS_TASKS_HARD_MAX) {
        return textResult({
          ok: false,
          error:
            `call_agents refused: tasks.length=${raw.length} exceeds hard max ${CALL_AGENTS_TASKS_HARD_MAX}.`,
        }, true)
      }
      const tasks = raw.map((t, i) => {
        const row = t && typeof t === 'object' && !Array.isArray(t) ? t as JsonObject : null
        if (!row || typeof row.agent !== 'string' || typeof row.prompt !== 'string') {
          throw new Error(`call_agents tasks[${i}] requires both agent and prompt strings.`)
        }
        return row
      })
      const parallelOn = isSubagentParallelEnabled()
      const concurrency = parallelOn ? Math.min(getSubagentParallelMax(), tasks.length) : 1
      const bus = getClient()
      try {
        const lanes = await mapPool(tasks, concurrency, async (task, index) => {
          const r = await bus.request('a2a', task, { signal })
          if (r.ok === false) {
            return {
              ok: false as const,
              index,
              agent: String(task.agent),
              error: typeof r.error === 'string' ? r.error : 'failed',
            }
          }
          return {
            ok: true as const,
            index,
            agent: typeof r.agent === 'string' ? r.agent : String(task.agent),
            jobId: r.jobId,
            durationMs: r.durationMs,
            result: r.result,
            ...(r.artifactsDir ? { artifactsDir: r.artifactsDir } : {}),
            ...(r.outputs ? { outputs: r.outputs } : {}),
            ...(r.warnings ? { warnings: r.warnings } : {}),
          }
        })
        const okCount = lanes.filter((l) => l.ok).length
        const payload = { ok: true, okCount, parallel: parallelOn, concurrency, lanes }
        return {
          content: [{
            type: 'text' as const,
            text: [
              `[call_agents join] ${okCount}/${lanes.length} succeeded `
              + `(parallel=${parallelOn ? 'on' : 'off'}, concurrency=${concurrency}).`,
              'Synthesize the lane results below into one user reply; do not dump raw transcripts.',
              JSON.stringify(payload),
            ].join('\n'),
          }],
          details: payload,
        }
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }, true)
      }
    },
  })
}
