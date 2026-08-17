import type { Decision, RunContext } from './approval-bus.js'
import { defaultAgentCwd } from './agent-cwd.js'
import type { DispatcherResult, ToolDispatcher } from './llm/tool-dispatcher.js'
import { buildExecDispatcher } from './llm/exec-dispatcher.js'
import { buildFsDispatcher } from './llm/fs-dispatcher.js'
import { buildWebDispatcher } from './llm/web-dispatcher.js'

type JsonObject = Record<string, unknown>
type NativeToolKey = 'web_search' | 'web_fetch' | 'bash' | 'write' | 'edit'

interface NativeToolSpec {
  key: NativeToolKey
  dispatchName: string
  approvalName?: 'Bash' | 'Write' | 'Edit'
}

const TOOL_ALIASES: Record<string, NativeToolSpec> = {
  web_search: { key: 'web_search', dispatchName: 'agim_web_search' },
  web_fetch: { key: 'web_fetch', dispatchName: 'agim_web_fetch' },
  native_web_search: { key: 'web_search', dispatchName: 'agim_web_search' },
  native_web_fetch: { key: 'web_fetch', dispatchName: 'agim_web_fetch' },
  agim_web_search: { key: 'web_search', dispatchName: 'agim_web_search' },
  agim_web_fetch: { key: 'web_fetch', dispatchName: 'agim_web_fetch' },

  agim_bash: { key: 'bash', dispatchName: 'agim_exec', approvalName: 'Bash' },
  agim_write: { key: 'write', dispatchName: 'agim_write_file', approvalName: 'Write' },
  agim_edit: { key: 'edit', dispatchName: 'agim_edit_file', approvalName: 'Edit' },
}

const webDispatcher = buildWebDispatcher()

export type NativeToolRpcResult =
  | { ok: true; result: string; source?: string }
  | { ok: false; error: string; source?: string }

export interface NativeToolApprovalRequest {
  toolName: 'Bash' | 'Write' | 'Edit'
  input: JsonObject
}

export interface NativeToolRpcOptions {
  reqId?: string
  signal?: AbortSignal
  runContext?: RunContext
  requestApproval?: (request: NativeToolApprovalRequest) => Promise<Decision>
}

export function normalizeNativeToolName(name: string): string | null {
  return TOOL_ALIASES[name]?.dispatchName ?? null
}

export async function handleNativeToolOp(
  payload: JsonObject,
  opts: NativeToolRpcOptions = {},
): Promise<NativeToolRpcResult> {
  const requested = typeof payload.name === 'string' ? payload.name : ''
  const spec = TOOL_ALIASES[requested]
  if (!spec) {
    return { ok: false, error: `native tool not exposed: ${requested || '(missing name)'}` }
  }

  const args = isJsonObject(payload.arguments) ? payload.arguments : {}
  const signal = opts.signal ?? new AbortController().signal
  if (!spec.approvalName) {
    return dispatchResult(await dispatchNative(spec, args, opts, signal))
  }

  if (opts.runContext?.callerPlanMode) {
    return { ok: false, error: `${requested} is blocked while plan mode is active` }
  }
  if (!opts.requestApproval) {
    return { ok: false, error: `${requested} requires approval, but no approval requester is available` }
  }

  const approvalInput = buildApprovalInput(spec.key, args)
  const decision = await opts.requestApproval({ toolName: spec.approvalName, input: approvalInput })
  if (decision.behavior === 'deny') {
    return { ok: false, error: decision.message || 'tool call denied by user' }
  }
  const approvedInput = isJsonObject(decision.updatedInput) ? decision.updatedInput : approvalInput
  const approvedArgs = buildDispatchArgs(spec.key, approvedInput)
  return dispatchResult(await dispatchNative(spec, approvedArgs, opts, signal))
}

async function dispatchNative(
  spec: NativeToolSpec,
  args: JsonObject,
  opts: NativeToolRpcOptions,
  signal: AbortSignal,
): Promise<DispatcherResult> {
  const call = {
    id: opts.reqId ?? `native-tool-${Date.now()}`,
    name: spec.dispatchName,
    arguments: args,
  }
  switch (spec.key) {
    case 'web_search':
    case 'web_fetch':
      return webDispatcher(call, signal, { traceId: opts.reqId })
    case 'bash':
      return execDispatcher(opts)(call, signal, { traceId: opts.reqId })
    case 'write':
    case 'edit':
      return fsDispatcher(opts)(call, signal, { traceId: opts.reqId })
  }
}

function execDispatcher(opts: NativeToolRpcOptions): ToolDispatcher {
  const ctx = opts.runContext
  return buildExecDispatcher({
    cwd: cwdFor(opts),
    ...(ctx ? {
      rpcCtx: {
        platform: ctx.platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        userId: ctx.userId,
      },
    } : {}),
  })
}

function fsDispatcher(opts: NativeToolRpcOptions): ToolDispatcher {
  return buildFsDispatcher({ cwd: cwdFor(opts) })
}

function dispatchResult(result: DispatcherResult): NativeToolRpcResult {
  if (result.isError) return { ok: false, error: result.text, source: result.source }
  return { ok: true, result: result.text, source: result.source }
}

function buildApprovalInput(key: NativeToolKey, args: JsonObject): JsonObject {
  switch (key) {
    case 'bash':
      return {
        command: stringArg(args.command),
        ...(typeof args.timeout_ms === 'number' ? { timeout_ms: args.timeout_ms } : {}),
        ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
      }
    case 'write':
      return {
        file_path: stringArg(args.path ?? args.file_path),
        content: stringArg(args.content),
        mode: args.mode === 'append' ? 'append' : 'overwrite',
      }
    case 'edit':
      return {
        file_path: stringArg(args.path ?? args.file_path),
        old_string: stringArg(args.old_string),
        new_string: stringArg(args.new_string),
        ...(args.replace_all === true ? { replace_all: true } : {}),
      }
    default:
      return args
  }
}

function buildDispatchArgs(key: NativeToolKey, input: JsonObject): JsonObject {
  switch (key) {
    case 'bash':
      return {
        command: stringArg(input.command),
        ...(typeof input.timeout_ms === 'number' ? { timeout_ms: input.timeout_ms } : {}),
        ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
      }
    case 'write':
      return {
        path: stringArg(input.path ?? input.file_path),
        content: stringArg(input.content),
        mode: input.mode === 'append' ? 'append' : 'overwrite',
      }
    case 'edit':
      return {
        path: stringArg(input.path ?? input.file_path),
        old_string: stringArg(input.old_string),
        new_string: stringArg(input.new_string),
        ...(input.replace_all === true ? { replace_all: true } : {}),
      }
    default:
      return input
  }
}

function cwdFor(opts: NativeToolRpcOptions): string {
  const ctx = opts.runContext
  if (ctx?.cwd) return ctx.cwd
  if (ctx?.callerAgent) return defaultAgentCwd(ctx.callerAgent)
  return process.cwd()
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
