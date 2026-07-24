// Bridges agim's tool surface (ToolDef[] schemas + a ToolDispatcher) onto pi's
// AgentTool[] so Agim Agent reuses agim's existing builtin / agim /
// MCP dispatchers unchanged.
//
// Two facts (validated against pi source, see CHANGELOG native engine overview):
//   - pi accepts a plain JSON Schema as AgentTool.parameters (it reads only
//     .properties / .required). agim's ToolDef.parameters is already that.
//   - pi has NO isError field on a tool result; a tool signals an error by
//     THROWING. agim's DispatcherResult returns { isError }. The bridge
//     translates an isError result into a throw so pi marks the tool result as
//     an error and the dispatcher's text still reaches the model.
//
// The bridge is also where two agent-loop.ts reliability caps are enforced for
// the pi (AgentHarness) path, since pi's loop has neither:
//   - per-tool result truncation (AGIM_NATIVE_TOOL_RESULT_MAX_CHARS): a single
//     5 MB grep / curl would otherwise poison the context for the rest of the
//     turn and silently blow the model input limit;
//   - per-tool wall timeout (AGIM_NATIVE_TOOL_TIMEOUT_MS / ToolDef.timeoutMs):
//     a wedged agim_exec / MCP call would otherwise hang the whole turn.

import { toolNameMatches } from '../../../core/llm/tool-names.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  beginGoalToolOperation,
  classifyGoalEvidence,
  finishGoalToolOperation,
  isDetachedGoalCommand,
  isGoalExecContainmentAvailable,
  type GoalEvidenceContext,
} from '../../../core/goal-evidence.js'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { DispatcherResult, ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { confirmUnconfinedGoalExec } from '../agim-agent-shared/index.js'

/** A never-aborted signal for when pi invokes execute without one. The agim
 *  ToolDispatcher contract requires a non-optional AbortSignal. */
const NEVER_ABORT = new AbortController().signal

/** Mirror agent-loop.ts: cap each tool's result text. Default 32768 chars
 *  (~8 KB tokens). Env override; 0 disables. Re-read per call so the Web
 *  settings toggle takes effect without a restart. */
const DEFAULT_TOOL_RESULT_MAX_CHARS = 32_768
function resolveToolResultMaxChars(): number {
  const raw = (process.env.AGIM_NATIVE_TOOL_RESULT_MAX_CHARS ?? '').trim()
  if (!raw) return DEFAULT_TOOL_RESULT_MAX_CHARS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TOOL_RESULT_MAX_CHARS
  return n
}

/** Mirror agent-loop.ts: per-tool wall timeout. A ToolDef may pin its own
 *  (e.g. an explicitly slow long_task sets timeoutMs: 0 to opt out). Default
 *  60s; env override; 0 disables. */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
function resolveToolTimeoutMs(perToolMs: number | undefined): number {
  if (typeof perToolMs === 'number' && perToolMs >= 0) return perToolMs
  const raw = (process.env.AGIM_NATIVE_TOOL_TIMEOUT_MS ?? '').trim()
  if (!raw) return DEFAULT_TOOL_TIMEOUT_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TOOL_TIMEOUT_MS
  return n
}

/** Truncate tool-result text with a clear marker so the model knows bytes were
 *  dropped. cap === 0 disables. */
function truncateToolResult(text: string, cap: number, toolName: string): string {
  if (cap === 0 || text.length <= cap) return text
  const dropped = text.length - cap
  return `${text.slice(0, cap)}\n\n…[${toolName} 输出已截断：省略 ${dropped}/${text.length} 字符；调高 AGIM_NATIVE_TOOL_RESULT_MAX_CHARS 可放宽]`
}

/** Run the dispatch with a per-tool wall timeout. Read-only/parallel-safe tools
 * may detach after abort; mutation-capable tools must settle before returning
 * so late side effects cannot bypass evidence invalidation. */
async function dispatchWithTimeout(
  run: (signal: AbortSignal) => Promise<DispatcherResult>,
  outer: AbortSignal,
  timeoutMs: number,
  toolName: string,
  detachOnAbort: boolean,
): Promise<DispatcherResult> {
  const abortError = () => {
    const err = new Error(`工具 ${toolName} 已取消`)
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
    // Reject the adapter-facing race first so a cooperative dispatcher that
    // resolves synchronously from its abort listener cannot win with "success".
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
      // Only read-only/parallel-safe tools may detach. Mutations wait for
      // their dispatcher to settle so no late side effect can land after the
      // evidence ledger has unblocked completion.
      const timeoutErr = new Error(`工具 ${toolName} 执行超过 ${timeoutMs}ms 已超时`)
      timeoutErr.name = 'TimeoutError'
      rejectTimeout?.(timeoutErr)
      // Propagate a named timeout reason so nested A2A does not mis-label
      // the abort as "Stopped by user".
      ctrl.abort(timeoutErr)
    }, timeoutMs)
  }

  const runP = run(ctrl.signal)
  // If the timeout wins the race, runP may still reject later — swallow it so
  // it doesn't surface as an unhandled rejection. This does not affect the
  // race result when runP wins (await below observes the original settlement).
  runP.catch(() => {})
  try {
    const races: Array<Promise<DispatcherResult>> = [runP]
    if (timeout) races.push(timeout)
    if (aborted) races.push(aborted)
    const result = await Promise.race(races)
    if (timedOut && !detachOnAbort) {
      // Mutations wait for settle after the wall abort. If the dispatcher still
      // succeeded (e.g. loop_verdict already ended the Loop), prefer that
      // outcome — a synthetic timeout here makes the model retry into
      // no_active_loop while the store is already closed.
      if (result && result.isError !== true) {
        const note = `\n\n[注：工具墙钟 ${timeoutMs}ms 已触发 abort，但副作用已成功提交]`
        return {
          ...result,
          text: `${result.text || ''}${note}`,
        }
      }
      return {
        text: `工具 ${toolName} 执行超过 ${timeoutMs}ms 已超时并已停止`,
        isError: true,
        source: 'timeout',
      }
    }
    return result
  } finally {
    if (timer) clearTimeout(timer)
    outer.removeEventListener('abort', onOuterAbort)
  }
}

export interface ToolBridgeApprovalCtx {
  runId: string
  platform: string
  channelId: string
  threadId: string
  userId: string
}

export interface ToolBridgeOptions {
  /** Forwarded into ToolDispatcherContext so dispatchers can correlate audit
   *  rows back to the originating turn. */
  traceId?: string
  /** agim's parallel-safe verdict per tool name (read-only tools may run
   *  concurrently). Defaults to sequential — the safe choice for mutating /
   *  stateful tools. */
  parallelSafe?: (toolName: string) => boolean
  /** Active goal snapshot captured for this turn. */
  goalEvidence?: GoalEvidenceContext
  /** Dynamic lookup supports long_task followed by tools in the same run. */
  resolveGoalEvidence?: () => GoalEvidenceContext | null
  /** Fail closed for mutations when goal state cannot be read. */
  goalLedgerAvailable?: () => boolean
  /**
   * IM/web identity for escalating unconfined `agim_exec` (no bwrap) to an
   * explicit approval card while a versioned goal is active.
   */
  approvalCtx?: ToolBridgeApprovalCtx
  /** Test seam — overrides the default confirmUnconfinedGoalExec helper. */
  confirmUnconfinedExec?: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<'allow' | 'deny'>
}

/** Wrap one agim ToolDef + the shared dispatcher into a pi AgentTool. */
export function agimToolToPi(def: ToolDef, dispatch: ToolDispatcher, opts: ToolBridgeOptions = {}): AgentTool {
  const parallelSafe = opts.parallelSafe?.(def.name) === true
  return {
    label: def.name,
    name: def.name,
    description: def.description,
    // pi reads only .properties/.required off this; agim's JSON Schema is fine.
    parameters: def.parameters as AgentTool['parameters'],
    executionMode: parallelSafe ? 'parallel' : 'sequential',
    execute: async (toolCallId, args, signal) => {
      const cap = resolveToolResultMaxChars()
      const timeoutMs = resolveToolTimeoutMs(def.timeoutMs)
      const parsedArgs = (args ?? {}) as Record<string, unknown>
      const evidenceKind = classifyGoalEvidence(def.name, parsedArgs, parallelSafe)
      const goalEvidence = opts.resolveGoalEvidence?.() ?? opts.goalEvidence ?? null
      if (goalEvidence && toolNameMatches(def.name, 'agim_exec')) {
        // Detached/background stays hard-blocked — never offer a card for it.
        if (isDetachedGoalCommand(parsedArgs)) {
          throw new Error('detached/background exec is not allowed while a versioned goal is active')
        }
        // No bwrap → ask the operator once (explicit), then run unconfined.
        if (!isGoalExecContainmentAvailable()) {
          const command = typeof parsedArgs.command === 'string' ? parsedArgs.command : ''
          let decision: 'allow' | 'deny' = 'deny'
          if (opts.confirmUnconfinedExec) {
            decision = await opts.confirmUnconfinedExec(parsedArgs, signal ?? undefined)
          } else if (opts.approvalCtx) {
            const timeoutRaw = parsedArgs.timeout_ms
            const timeoutMs = typeof timeoutRaw === 'number' ? timeoutRaw
              : typeof timeoutRaw === 'string' ? Number.parseInt(timeoutRaw, 10) : undefined
            decision = await confirmUnconfinedGoalExec({
              ...opts.approvalCtx,
              command,
              timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
              cwd: typeof parsedArgs.cwd === 'string' ? parsedArgs.cwd : undefined,
              signal: signal ?? undefined,
            })
          } else {
            throw new Error(
              'agim_exec requires bwrap process containment while a versioned goal is active',
            )
          }
          if (decision !== 'allow') {
            throw new Error(
              'agim_exec denied: unconfined execution while a versioned goal is active (no bwrap)',
            )
          }
        }
      }
      let operation: ReturnType<typeof beginGoalToolOperation> = null
      if (goalEvidence) {
        try {
          operation = beginGoalToolOperation({
            context: goalEvidence,
            toolCallId,
            toolName: def.name,
            args: parsedArgs,
            kind: evidenceKind,
          })
        } catch (err) {
          console.error('[native] goal evidence begin failed:', err instanceof Error ? err.message : err)
        }
        if (
          !operation
          && (evidenceKind === 'mutation' || evidenceKind === 'mutation_verification')
        ) {
          throw new Error('goal evidence ledger unavailable; mutating tool blocked')
        }
      } else if (
        opts.goalLedgerAvailable?.() === false
        && (evidenceKind === 'mutation' || evidenceKind === 'mutation_verification')
      ) {
        throw new Error('goal state unavailable; mutating tool blocked')
      }
      let result: DispatcherResult
      try {
        result = await dispatchWithTimeout(
          (sig) => dispatch(
            { id: toolCallId, name: def.name, arguments: parsedArgs },
            sig,
            opts.traceId ? { traceId: opts.traceId } : undefined,
          ),
          signal ?? NEVER_ABORT,
          timeoutMs,
          def.name,
          parallelSafe,
        )
      } catch (err) {
        try {
          const message = err instanceof Error ? err.message : String(err)
          const uncertain = (
            evidenceKind === 'mutation' || evidenceKind === 'mutation_verification'
          ) && (
            (err instanceof Error && err.name === 'AbortError')
            || /timed out|超时|已取消/i.test(message)
          )
          finishGoalToolOperation(operation, {
            ok: false,
            output: message,
            uncertain,
          })
        } catch { /* evidence failure must not hide the original tool error */ }
        throw err
      }
      let evidence: ReturnType<typeof finishGoalToolOperation> = null
      try {
        evidence = finishGoalToolOperation(operation, {
          ok: !result.isError,
          output: result.text,
          uncertain: result.isError
            && (evidenceKind === 'mutation' || evidenceKind === 'mutation_verification'),
          metadata: { source: result.source ?? 'unknown' },
        })
      } catch (err) {
        console.error('[native] goal evidence finish failed:', err instanceof Error ? err.message : err)
      }
      const text = truncateToolResult(result.text, cap, def.name)
      // pi marks errors via throw (no isError field on its result shape).
      if (result.isError) throw new Error(text)
      const evidenceMarker = evidence
        ? `\n\n[agim evidence ${evidence.kind}: ${evidence.id} · epoch ${evidence.epoch}]`
        : ''
      return { content: [{ type: 'text', text: text + evidenceMarker }], details: undefined }
    },
  }
}

/** Bridge a whole agim tool surface at once. */
export function agimToolsToPi(tools: ToolDef[], dispatch: ToolDispatcher, opts: ToolBridgeOptions = {}): AgentTool[] {
  return tools.map((def) => agimToolToPi(def, dispatch, opts))
}
