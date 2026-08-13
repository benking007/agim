// Shared tool-call spine: pre (schema) → execute (timeout) → post (truncate + audit).
//
// Production Agim Agent goes through pi `tool_call` → tool-bridge → dispatchers.
// The retired `runAgentLoop` had schema validation + per-call audit that the
// Pi path skipped. This module is the single implementation both sides use.
// Do not resurrect runAgentLoop in production.

import { logger as rootLogger } from '../logger.js'
import { logInvocation } from '../audit-log.js'
import { resolveSchemaValidate } from './agent-loop-config.js'
import { extractErrorType } from './agent-loop-stuck.js'
import { formatValidationErrors, validateAgainstSchema } from './schema-validate.js'
import type { DispatcherResult } from './tool-dispatcher.js'

const log = rootLogger.child({ component: 'tool-call-spine' })

export interface ToolTimeoutMessages {
  abort: (toolName: string) => string
  timeout: (toolName: string, ms: number) => string
  timeoutStopped: (toolName: string, ms: number) => string
  timeoutSettledNote: (toolName: string, ms: number) => string
}

export const EN_TOOL_TIMEOUT_MESSAGES: ToolTimeoutMessages = {
  abort: (toolName) => `tool ${toolName} cancelled`,
  timeout: (toolName, ms) =>
    `tool ${toolName} timed out after ${ms}ms (set AGIM_NATIVE_TOOL_TIMEOUT_MS or the tool's timeoutMs to raise the cap)`,
  timeoutStopped: (toolName, ms) => `tool ${toolName} timed out after ${ms}ms and was stopped`,
  timeoutSettledNote: (_toolName, ms) =>
    `\n\n[note: wall clock ${ms}ms abort fired, but the side effect already committed]`,
}

export const ZH_TOOL_TIMEOUT_MESSAGES: ToolTimeoutMessages = {
  abort: (toolName) => `工具 ${toolName} 已取消`,
  timeout: (toolName, ms) => `工具 ${toolName} 执行超过 ${ms}ms 已超时`,
  timeoutStopped: (toolName, ms) => `工具 ${toolName} 执行超过 ${ms}ms 已超时并已停止`,
  timeoutSettledNote: (_toolName, ms) =>
    `\n\n[注：工具墙钟 ${ms}ms 已触发 abort，但副作用已成功提交]`,
}

/**
 * Run a dispatcher with a per-tool wall timeout.
 *
 * `detachOnAbort: true` (read-only / parallel-safe): race timeout vs invoke
 * and return immediately; the invoke promise is swallowed if it loses.
 * `detachOnAbort: false` (mutations): abort the signal, then wait for the
 * dispatcher to settle so late side effects cannot land after the caller
 * has moved on.
 */
export async function dispatchToolWithTimeout(
  run: (signal: AbortSignal) => Promise<DispatcherResult>,
  outer: AbortSignal,
  timeoutMs: number,
  toolName: string,
  opts: {
    detachOnAbort: boolean
    messages?: ToolTimeoutMessages
  },
): Promise<DispatcherResult> {
  const messages = opts.messages ?? EN_TOOL_TIMEOUT_MESSAGES
  const detachOnAbort = opts.detachOnAbort
  const abortError = () => {
    const err = new Error(messages.abort(toolName))
    err.name = 'AbortError'
    return err
  }
  if (outer.aborted) throw abortError()

  const ctrl = new AbortController()
  let rejectAbort: ((reason?: unknown) => void) | undefined
  const aborted = detachOnAbort
    ? new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    : null
  const onOuterAbort = () => {
    rejectAbort?.(abortError())
    ctrl.abort(outer.reason)
  }
  outer.addEventListener('abort', onOuterAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let rejectTimeout: ((reason?: unknown) => void) | undefined
  const timeout = timeoutMs > 0 && detachOnAbort
    ? new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
    : null
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      const timeoutErr = new Error(messages.timeout(toolName, timeoutMs))
      timeoutErr.name = 'TimeoutError'
      rejectTimeout?.(timeoutErr)
      ctrl.abort(timeoutErr)
    }, timeoutMs)
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      timer.unref()
    }
  }

  const runP = run(ctrl.signal)
  runP.catch(() => {})
  try {
    const races: Array<Promise<DispatcherResult>> = [runP]
    if (timeout) races.push(timeout)
    if (aborted) races.push(aborted)
    const result = await Promise.race(races)
    if (timedOut && !detachOnAbort) {
      if (result && result.isError !== true) {
        return {
          ...result,
          text: `${result.text || ''}${messages.timeoutSettledNote(toolName, timeoutMs)}`,
        }
      }
      return {
        text: messages.timeoutStopped(toolName, timeoutMs),
        isError: true,
        source: 'timeout',
      }
    }
    return result
  } finally {
    if (timer) clearTimeout(timer)
    outer.removeEventListener('abort', onOuterAbort)
    if (timedOut) {
      log.warn({ event: 'tool-call.timeout', tool: toolName, timeoutMs, detachOnAbort })
    }
  }
}

/** Pre-dispatch JSON-Schema check. Off via AGIM_TOOL_SCHEMA_VALIDATE=off. */
export function prevalidateToolArgs(
  toolName: string,
  args: unknown,
  schema: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!resolveSchemaValidate() || !schema) return { ok: true }
  const verrs = validateAgainstSchema(args, schema)
  if (verrs.length === 0) return { ok: true }
  return { ok: false, message: formatValidationErrors(toolName, verrs) }
}

export interface ToolCallAuditCtx {
  traceId?: string
  userId?: string
  platform?: string
  agent?: string
}

/** Post-dispatch audit row (best-effort). Same shape as retired runAgentLoop. */
export function postAuditToolCall(
  audit: ToolCallAuditCtx | undefined,
  report: {
    name: string
    isError: boolean
    durationMs: number
    preview: string
    source?: string
    argsKey?: string
    decision?: 'allow' | 'deny'
  },
): void {
  if (!audit) return
  try {
    logInvocation({
      traceId: audit.traceId ?? `agent-loop-${Date.now()}`,
      userId: audit.userId ?? '',
      platform: audit.platform ?? 'native-agent',
      agent: audit.agent ?? 'agim',
      intent: `tool.${report.name}`,
      promptLen: report.argsKey?.length ?? 0,
      responseLen: report.preview?.length ?? 0,
      durationMs: report.durationMs,
      cost: 0,
      success: !report.isError,
      error: extractErrorType(report.isError, report.preview) || undefined,
    })
  } catch { /* audit best-effort */ }
}
