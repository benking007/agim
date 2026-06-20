// PiNativeAgentAdapter — agim's AgentAdapter backed by pi's AgentHarness.
//
// This is the orchestration half of the pi-native engine: it maps agim's
// sendPrompt contract onto a pi AgentHarness with durable per-session storage,
// the agim tool bridge, and plan-mode enforcement. The provider/auth half
// (agim BackendConfig → pi-ai Model + key) is INJECTED via `resolveModel` so
// it can be wired and tested independently.
//
// Validated mappings (PROJECTS/pi-native-migration.md, P0–P2 spikes):
//   - sessionId   → JsonlSessionRepo session file (durable; survives restart;
//                   pi owns history, so agim need not re-thread it each turn)
//   - history     → seeded into a COLD session only
//   - opts.planMode → tool_call hook blocks mutating tools
//   - opts.onUsage  → surfaced from the returned AssistantMessage.usage
//   - yields        → final assistant text (buffered; token streaming is a
//                     follow-up — pi exposes an event stream we can wire later)

import { AgentHarness, JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { Model } from '@earendil-works/pi-ai'
import type { AgentAdapter, AgentAdapterKind, AgentSendOpts, ChatMessage } from '../../../core/types.js'
import type { ApprovalGate } from '../../../core/llm/agent-loop.js'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { agimToolsToPi } from './tool-bridge.js'

/** Resolved LLM binding for one turn: a pi-ai Model + how to authenticate it. */
export interface PiModelBinding {
  model: Model<string>
  getApiKeyAndHeaders: () => Promise<{ apiKey: string; headers: Record<string, string> }>
}

export interface PiNativeDeps {
  /** Adapter name to register under. Defaults to 'pi-native'; the default
   *  engine registers as 'native' to transparently replace the legacy one. */
  name?: string
  /** Adapter aliases. Defaults to ['pi']. */
  aliases?: string[]
  /** Directory under which per-session JSONL files live. */
  sessionsRoot: string
  /** agim BackendConfig → pi-ai Model + auth. Returns null when no backend is
   *  configured (adapter then reports unavailable / fails the turn cleanly). */
  resolveModel: (opts?: AgentSendOpts) => Promise<PiModelBinding | null>
  /** The agim tool surface (schemas + dispatcher) to expose this turn. Receives
   *  the session id so per-thread tool state (todo tracker, plan-exit) keys
   *  correctly. */
  resolveTools?: (
    opts: AgentSendOpts | undefined,
    sessionId: string,
  ) => { tools: ToolDef[]; dispatch: ToolDispatcher; parallelSafe?: (toolName: string) => boolean } | null
  /** Tool names denied under plan-mode (mutating/stateful). */
  planModeMutatingTools?: ReadonlySet<string>
  /** Read-only verdict for parallel tool execution. */
  parallelSafe?: (toolName: string) => boolean
  /** Per-turn agim policy approval gate (read-only / allow-list / deny-all +
   *  IM approval-card escalation). Consulted from the beforeToolCall hook. */
  resolveApprovalGate?: (opts: AgentSendOpts | undefined, sessionId: string) => ApprovalGate | null
  /** Max tool-call rounds per turn before the loop is force-stopped. pi's loop
   *  has no built-in cap, so we enforce one (mirrors agim's
   *  IMHUB_NATIVE_AGENT_MAX_ITER). Defaults to 50; clamped to [1, 100]. */
  maxIterations?: number
}

const DEFAULT_MAX_ITER = 50

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null'
  } catch {
    return String(v)
  }
}

const DEFAULT_PLAN_DENY: ReadonlySet<string> = new Set(['native_write', 'native_exec'])

function seedUserMessage(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() }
}
function seedAssistantMessage(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'anthropic-messages',
    provider: 'seed',
    model: 'seed',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  }
}

export class PiNativeAgentAdapter implements AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  readonly kind: AgentAdapterKind = 'in-process'

  constructor(private deps: PiNativeDeps) {
    // When pi is the default engine it registers UNDER the 'native' name so
    // existing routing (and `/cc native`) resolves to it transparently.
    this.name = deps.name ?? 'pi-native'
    this.aliases = deps.aliases ?? ['pi']
  }

  async isAvailable(): Promise<boolean> {
    return (await this.deps.resolveModel()) !== null
  }

  describe(): string | undefined {
    return 'engine: pi-agent-core'
  }

  async *sendPrompt(
    sessionId: string,
    prompt: string,
    history?: ChatMessage[],
    opts?: AgentSendOpts,
  ): AsyncGenerator<string> {
    const binding = await this.deps.resolveModel(opts)
    if (!binding) throw new Error('pi-native: no LLM backend configured (resolveModel returned null)')

    const env = new NodeExecutionEnv({ cwd: this.deps.sessionsRoot })
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: this.deps.sessionsRoot })

    // One JSONL file per agim session id. Reopen if it exists (pi owns the
    // history + leaf), else create a fresh one and seed prior agim history.
    const existing = (await repo.list()).find((m) => m.id === sessionId)
    const fresh = !existing
    const session = existing
      ? await repo.open(existing)
      : await repo.create({ cwd: this.deps.sessionsRoot, id: sessionId })

    const toolSurface = this.deps.resolveTools?.(opts, sessionId) ?? null
    const tools = toolSurface
      ? agimToolsToPi(toolSurface.tools, toolSurface.dispatch, {
          traceId: opts?.traceId,
          parallelSafe: toolSurface.parallelSafe ?? this.deps.parallelSafe,
        })
      : []

    const harness = new AgentHarness({
      env,
      session,
      model: binding.model,
      getApiKeyAndHeaders: binding.getApiKeyAndHeaders,
      tools,
    })

    const gate = this.deps.resolveApprovalGate?.(opts, sessionId) ?? null
    const planDeny = this.deps.planModeMutatingTools ?? DEFAULT_PLAN_DENY
    if (opts?.planMode || gate) {
      harness.on(
        'tool_call',
        async (ev: { toolName: string; toolCallId: string; input: unknown }) => {
          // Plan-mode hard deny (covers A2A-propagated plan-mode even without
          // an IM thread for the policy gate to read).
          if (opts?.planMode && planDeny.has(ev.toolName)) {
            return { block: true, reason: 'plan-mode: mutating tools are denied' }
          }
          // agim policy gate: read-only / allow-list / deny-all, escalating to
          // an IM approval card when configured.
          if (gate) {
            const decision = await gate(
              { id: ev.toolCallId, name: ev.toolName, arguments: (ev.input ?? {}) as Record<string, unknown> },
              0,
            )
            if (decision === 'deny') return { block: true, reason: `denied by policy: ${ev.toolName}` }
          }
          return undefined
        },
      )
    }

    // Runaway guards: pi's loop has no iteration cap and no stuck-loop
    // detection, so we enforce both via the tool_result terminate hint.
    const maxIter = Math.max(1, Math.min(this.deps.maxIterations ?? DEFAULT_MAX_ITER, 100))
    let toolRounds = 0
    let stopReason: 'max_iter' | 'stuck_loop' | null = null
    const recentSigs: string[] = []
    harness.on('tool_result', (ev: { toolName?: string; input?: unknown; isError?: boolean }) => {
      toolRounds += 1
      if (toolRounds >= maxIter) {
        stopReason = 'max_iter'
        return { terminate: true }
      }
      // Stuck-loop: the same tool + same args erroring 3× in a row (mirrors
      // agim's exact stuck-loop detector — catches a model wedged on one
      // failing call well before it burns the whole iteration budget).
      const sig = `${ev.toolName}|${safeJson(ev.input)}|${ev.isError ? 'E' : 'ok'}`
      recentSigs.push(sig)
      if (recentSigs.length > 3) recentSigs.shift()
      if (ev.isError && recentSigs.length === 3 && recentSigs.every((s) => s === sig)) {
        stopReason = 'stuck_loop'
        return { terminate: true }
      }
      return undefined
    })

    if (fresh && history?.length) {
      for (const m of history) {
        await harness.appendMessage(m.role === 'user' ? seedUserMessage(m.content) : seedAssistantMessage(m.content))
      }
    }

    const result = await harness.prompt(prompt)

    if (opts?.onUsage && result.usage) {
      opts.onUsage({
        tokensInput: result.usage.input,
        tokensOutput: result.usage.output,
        costUsd: result.usage.cost?.total,
      })
    }

    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    if (stopReason && !text.trim()) {
      yield stopReason === 'stuck_loop'
        ? '（检测到工具反复以相同参数失败的死循环，已提前停止）'
        : `（已达最大迭代步数 ${maxIter}，提前停止；可调高 IMHUB_NATIVE_AGENT_MAX_ITER 后重试）`
      return
    }
    yield text
  }
}
