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
import {
  dispatchToolWithTimeout,
  postAuditToolCall,
  prevalidateToolArgs,
  ZH_TOOL_TIMEOUT_MESSAGES,
  type ToolCallAuditCtx,
} from '../../../core/llm/tool-call-spine.js'
import {
  resolveToolResultMaxChars,
  resolveDispatchTimeoutMs,
} from '../../../core/llm/agent-loop-config.js'

/** A never-aborted signal for when pi invokes execute without one. The agim
 *  ToolDispatcher contract requires a non-optional AbortSignal. */
const NEVER_ABORT = new AbortController().signal

/** Truncate tool-result text with a clear marker so the model knows bytes were
 *  dropped. cap === 0 disables. */
function truncateToolResult(text: string, cap: number, toolName: string): string {
  if (cap === 0 || text.length <= cap) return text
  const dropped = text.length - cap
  return `${text.slice(0, cap)}\n\n…[${toolName} 输出已截断：省略 ${dropped}/${text.length} 字符；调高 AGIM_NATIVE_TOOL_RESULT_MAX_CHARS 可放宽]`
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
  /** Dynamic lookup reflects Focus-backed goal state during a run. */
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
  /** Parent-turn identity for per-tool audit rows (Pi path previously skipped these). */
  audit?: ToolCallAuditCtx
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
      const parsedArgs = (args ?? {}) as Record<string, unknown>
      const timeoutMs = resolveDispatchTimeoutMs(def.timeoutMs, parsedArgs)
      const schemaFail = prevalidateToolArgs(def.name, parsedArgs, def.parameters)
      if (!schemaFail.ok) {
        postAuditToolCall(opts.audit, {
          name: def.name,
          isError: true,
          durationMs: 0,
          preview: schemaFail.message,
          source: 'schema-validation',
        })
        throw new Error(schemaFail.message)
      }
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
      const dispatchT0 = Date.now()
      try {
        result = await dispatchToolWithTimeout(
          (sig) => dispatch(
            { id: toolCallId, name: def.name, arguments: parsedArgs },
            sig,
            opts.traceId ? { traceId: opts.traceId } : undefined,
          ),
          signal ?? NEVER_ABORT,
          timeoutMs,
          def.name,
          { detachOnAbort: parallelSafe, messages: ZH_TOOL_TIMEOUT_MESSAGES },
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        postAuditToolCall(opts.audit, {
          name: def.name,
          isError: true,
          durationMs: Date.now() - dispatchT0,
          preview: message,
          source: 'timeout',
        })
        try {
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
      postAuditToolCall(opts.audit, {
        name: def.name,
        isError: !!result.isError,
        durationMs: Date.now() - dispatchT0,
        preview: result.text,
        source: result.source,
      })
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
