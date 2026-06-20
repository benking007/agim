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
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { agimToolsToPi } from './tool-bridge.js'

/** Resolved LLM binding for one turn: a pi-ai Model + how to authenticate it. */
export interface PiModelBinding {
  model: Model<string>
  getApiKeyAndHeaders: () => Promise<{ apiKey: string; headers: Record<string, string> }>
}

export interface PiNativeDeps {
  /** Directory under which per-session JSONL files live. */
  sessionsRoot: string
  /** agim BackendConfig → pi-ai Model + auth. Returns null when no backend is
   *  configured (adapter then reports unavailable / fails the turn cleanly). */
  resolveModel: (opts?: AgentSendOpts) => Promise<PiModelBinding | null>
  /** The agim tool surface (schemas + dispatcher) to expose this turn. */
  resolveTools?: (opts?: AgentSendOpts) => { tools: ToolDef[]; dispatch: ToolDispatcher } | null
  /** Tool names denied under plan-mode (mutating/stateful). */
  planModeMutatingTools?: ReadonlySet<string>
  /** Read-only verdict for parallel tool execution. */
  parallelSafe?: (toolName: string) => boolean
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
  readonly name = 'pi-native'
  readonly aliases: string[] = ['pi']
  readonly kind: AgentAdapterKind = 'in-process'

  constructor(private deps: PiNativeDeps) {}

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

    const toolSurface = this.deps.resolveTools?.(opts) ?? null
    const tools = toolSurface
      ? agimToolsToPi(toolSurface.tools, toolSurface.dispatch, {
          traceId: opts?.traceId,
          parallelSafe: this.deps.parallelSafe,
        })
      : []

    const harness = new AgentHarness({
      env,
      session,
      model: binding.model,
      getApiKeyAndHeaders: binding.getApiKeyAndHeaders,
      tools,
    })

    if (opts?.planMode) {
      const deny = this.deps.planModeMutatingTools ?? DEFAULT_PLAN_DENY
      harness.on('tool_call', (ev: { toolName: string }) =>
        deny.has(ev.toolName) ? { block: true, reason: 'plan-mode: mutating tools are denied' } : undefined,
      )
    }

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

    yield result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
  }
}
