// NativeAgentAdapter — agim's single Agim Agent adapter backed by pi's AgentHarness.
//
// This maps agim's
// sendPrompt contract onto a pi AgentHarness with durable per-session storage,
// the agim tool bridge, and plan-mode enforcement. The provider/auth half
// (agim BackendConfig → pi-ai Model + key) is INJECTED via `resolveModel` so
// it can be wired and tested independently.
//
// Validated mappings (see CHANGELOG native engine overview):
//   - sessionId   → JsonlSessionRepo session file (durable; survives restart;
//                   pi owns history, so agim need not re-thread it each turn)
//   - history     → seeded into a COLD session only
//   - opts.planMode → tool_call hook blocks mutating tools
//   - opts.onUsage  → surfaced from the returned AssistantMessage.usage
//   - compaction    → before each turn, summarize old history when the session
//                     exceeds the model window (pi never auto-compacts)
//   - yields        → final assistant text (buffered; token streaming is a
//                     follow-up — pi exposes an event stream we can wire later)

import {
  AgentHarness,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  getLastAssistantUsage,
  JsonlSessionRepo,
  shouldCompact,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { AgentHarnessStreamOptions } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import { chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentAdapter, AgentAdapterKind, AgentSendOpts, ChatMessage } from '../../../core/types.js'
import type { ApprovalGate } from '../../../core/llm/agent-loop.js'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { PLAN_EXIT_TOOL_NAME } from '../../../core/llm/plan-exit-dispatcher.js'
import { PLAN_MODE_DENY_TOOLS } from '../native/index.js'
import { agimToolsToPi } from './tool-bridge.js'

/** Resolved LLM binding for one turn: a pi-ai Model + how to authenticate it. */
export interface NativeModelBinding {
  model: Model<string>
  getApiKeyAndHeaders: () => Promise<{ apiKey: string; headers: Record<string, string> }>
}

export interface NativeModelChoice {
  name: string
  providerType?: string
  model?: string
}

export interface NativeAgentDeps {
  /** Adapter name to register under. Defaults to 'native'. */
  name?: string
  /** Adapter aliases. Defaults to the public Agim Agent aliases. */
  aliases?: string[]
  /** Directory under which per-session JSONL files live. */
  sessionsRoot: string
  /** agim BackendConfig → pi-ai Model + auth. Returns null when no backend is
   *  configured (adapter then reports unavailable / fails the turn cleanly). */
  resolveModel: (opts?: AgentSendOpts) => Promise<NativeModelBinding | null>
  /** Optional model roster for direct adapter slash-command fallback. The
   *  normal web/IM path handles `/models` in the router; this keeps REST/job
   *  style direct calls from sending the command to the LLM as plain text. */
  listModels?: () => NativeModelChoice[]
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
  /** Per-turn system prompt (runtime identity: real backend + model + role,
   *  operator role, skill routing, tool guides). Without it the model has no
   *  idea what it is and hallucinates its identity. */
  resolveSystemPrompt?: (opts: AgentSendOpts | undefined, sessionId: string) => string | undefined
  /** Max tool-call rounds per turn before the loop is force-stopped. pi's loop
   *  has no built-in cap, so we enforce one (mirrors agim's
   *  AGIM_NATIVE_AGENT_MAX_ITER). Defaults to 50; clamped to [1, 100]. */
  maxIterations?: number
  /** Proactive context compaction before each turn. pi never auto-compacts, so
   *  when a durable session grows past the model window (minus reserve) the
   *  adapter summarizes old history — without this, long-lived IM sessions grow
   *  the JSONL unbounded until the context overflows. Defaults to enabled; set
   *  false (factory reads AGIM_NATIVE_COMPACTION=off) to disable. */
  compactionEnabled?: boolean
  /** Provider request resilience + caching, snapshotted per turn by pi:
   *  maxRetries / maxRetryDelayMs / timeoutMs (ride out transient 429/5xx from
   *  the LLM provider) + cacheRetention (provider prompt cache → cuts the repeat
   *  token cost of the system prompt + history). Factory builds it from
   *  AGIM_NATIVE_* envs; omit to use pi defaults. */
  streamOptions?: AgentHarnessStreamOptions
}

const DEFAULT_MAX_ITER = 50

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null'
  } catch {
    return String(v)
  }
}

async function waitForTurnSlot(previous: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await previous
    return true
  }
  if (signal.aborted) return false
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    previous.then(() => finish(true), (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })
  })
}

interface NativeToolRun {
  name: string
  isError: boolean
  preview?: string
}

interface NativeToolResultEvent {
  toolName?: string
  input?: unknown
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
  details?: unknown
}

function previewToolResult(ev: NativeToolResultEvent): string | undefined {
  const contentText = (ev.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (contentText) return contentText.slice(0, 180)
  if (typeof ev.details === 'string' && ev.details.trim()) return ev.details.trim().replace(/\s+/g, ' ').slice(0, 180)
  if (ev.details !== undefined) return safeJson(ev.details).replace(/\s+/g, ' ').slice(0, 180)
  return undefined
}

function composeEmptyTurnRecap(toolRuns: readonly NativeToolRun[], availableToolNames: readonly string[]): string {
  if (toolRuns.length === 0) {
    const sample = availableToolNames.slice(0, 8)
    const toolHint = availableToolNames.length === 0
      ? '当前没有启用任何工具。'
      : `当前已启用 ${availableToolNames.length} 个工具（示例：${sample.join(', ')}${availableToolNames.length > sample.length ? ' …' : ''}）。`
    return [
      '🧐 这一轮没有产出可见回复。',
      '可能是模型返回了空内容，或把你的问题误判成无需继续。',
      toolHint,
      '',
      '你可以：',
      '  · 回「重试」让我再跑一遍',
      '  · 或换个更具体的问法',
      '  · 若持续出现，请在 /settings/llm 切换大模型后端再试',
    ].join('\n')
  }

  const counts = new Map<string, { count: number; errors: number }>()
  for (const t of toolRuns) {
    const prev = counts.get(t.name)
    if (prev) {
      prev.count += 1
      if (t.isError) prev.errors += 1
    } else {
      counts.set(t.name, { count: 1, errors: t.isError ? 1 : 0 })
    }
  }

  const last = toolRuns[toolRuns.length - 1]
  const lines: string[] = ['🧾 这一轮有执行工具，但没有生成收尾文字。', '已执行：']
  for (const [name, meta] of counts) {
    const mark = meta.errors === 0 ? '✓' : meta.errors === meta.count ? '✗' : '⚠️'
    const times = meta.count > 1 ? ` ×${meta.count}` : ''
    const partial = meta.errors > 0 && meta.errors < meta.count ? `（其中 ${meta.errors} 次失败）` : ''
    lines.push(`  ${mark} ${name}${times}${partial}`)
  }
  if (last?.preview) {
    lines.push('', `最后一步结果摘要：${last.preview}${last.preview.length >= 180 ? '…' : ''}`)
  }
  lines.push('', '你可以回「继续」让我基于这些结果给出结论，或直接换个问法。')
  return lines.join('\n')
}

function appendPartialToolDiagnostics(text: string, toolRuns: readonly NativeToolRun[], stopReason: 'max_iter' | 'stuck_loop' | null, maxIter: number): string {
  const diagnostics: string[] = []
  if (stopReason === 'stuck_loop') {
    diagnostics.push('检测到工具反复以相同参数失败，已提前停止；以上内容可能只覆盖已取得的信息。')
  } else if (stopReason === 'max_iter') {
    diagnostics.push(`已达到最大迭代步数 ${maxIter}，已提前停止；以上内容可能不完整。`)
  }

  const failed = toolRuns.filter((t) => t.isError)
  if (failed.length > 0) {
    const names = [...new Set(failed.map((t) => t.name))].slice(0, 4)
    diagnostics.push(`本轮有 ${failed.length} 次工具调用失败或被阻断（${names.join('、')}），回复基于已成功取得的信息。`)
  }

  if (diagnostics.length === 0) return text
  return `${text.trimEnd()}\n\n（诊断：${diagnostics.join(' ')}）`
}

/** Cap for the provider error detail surfaced to the user — enough to
 *  identify the failure ("terminated", "socket hang up", a 5xx snippet)
 *  without dumping a whole stack trace into the chat. */
const PROVIDER_ERROR_DETAIL_MAX = 200

/**
 * Friendly notice for a provider-level failure (network drop / timeout / 5xx)
 * or an aborted turn. pi does NOT throw these — it returns an assistant
 * message with stopReason 'error' | 'aborted', an `errorMessage`, and an empty
 * text block (see AgentHarness.emitRunFailure → createFailureMessage). Without
 * special-casing it, such a turn would be misreported as "the model returned
 * empty content". Instead we name the real cause and steer the user to retry —
 * a retry is a brand-new turn, so there is no partial state to unwind.
 */
function composeProviderErrorNotice(kind: 'error' | 'aborted', errorMessage?: string): string {
  if (kind === 'aborted') {
    return '🛑 本轮已被取消（未完成）。可回「重试」重新发起。'
  }
  const raw = errorMessage?.trim() ?? ''
  const clipped = raw.length > PROVIDER_ERROR_DETAIL_MAX ? `${raw.slice(0, PROVIDER_ERROR_DETAIL_MAX)}…` : raw
  const detail = clipped ? `：${clipped}` : ''
  return [
    `⚠️ 本轮因网络或模型服务中断而未完成${detail}`,
    '这类问题通常是临时的（连接被重置 / 请求超时 / 服务 5xx）。',
    '你可以：',
    '  · 回「重试」让我重新跑一遍',
    '  · 稍后再试，或在 /settings/llm 切换大模型后端',
  ].join('\n')
}

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

export class NativeAgentAdapter implements AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  readonly kind: AgentAdapterKind = 'in-process'
  readonly handlesAgimSkillsPrompt = true

  // sessionId → JSONL metadata. Avoids a full repo.list() scan (which reads
  // every session file's header) on every turn; bounds it to one scan per
  // session per process lifetime.
  private readonly sessionMeta = new Map<string, Awaited<ReturnType<JsonlSessionRepo['list']>>[number]>()
  private readonly sessionModelOverrides = new Map<string, string>()

  // Per-sessionId serial lock. IM threads reuse one session id across
  // messages (session.ts getOrCreateSession), and that id maps to a single
  // pi JSONL session file. Two concurrent turns would each open their own
  // AgentHarness over the SAME file and interleave appendFile writes →
  // corrupted history / lost leaf. pi's own busy-guard doesn't help because
  // we build a fresh harness per turn. Each turn chains behind the previous
  // one for the same id; unique-id callers (A2A / web jobs) get a length-1
  // chain, so there is no contention for them.
  private readonly sessionLocks = new Map<string, Promise<void>>()

  constructor(private deps: NativeAgentDeps) {
    this.name = deps.name ?? 'native'
    this.aliases = deps.aliases ?? ['agim', 'na', 'llm', 'native-llm']
  }

  async isAvailable(): Promise<boolean> {
    return (await this.deps.resolveModel()) !== null
  }

  describe(): string | undefined {
    return 'engine=agim-agent'
  }

  async *sendPrompt(
    sessionId: string,
    prompt: string,
    history?: ChatMessage[],
    opts?: AgentSendOpts,
  ): AsyncGenerator<string> {
    // Serialize turns that share a session id (see sessionLocks). Chain this
    // turn behind whatever is already queued for the same id, and release the
    // slot when the turn (or an early consumer abandon) settles.
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const mine = prev.then(() => held)
    this.sessionLocks.set(sessionId, mine)
    try {
      const acquired = await waitForTurnSlot(prev, opts?.signal)
      if (!acquired) {
        yield composeProviderErrorNotice('aborted')
        return
      }
      yield* this.runTurn(sessionId, prompt, history, opts)
    } catch (err) {
      if (opts?.signal?.aborted) {
        yield composeProviderErrorNotice('aborted')
        return
      }
      // Never fail silently: a thrown turn would otherwise reach the IM layer
      // as "no response". Surface the error so it's visible + diagnosable.
      const msg = err instanceof Error ? `${err.message}` : String(err)
      console.error('[native] turn failed:', err instanceof Error ? err.stack : err)
      yield `⚠️ Agim Agent 本轮出错：${msg}`
    } finally {
      release()
      // Drop our slot only if nobody queued behind us, so a waiter keeps its ref.
      if (this.sessionLocks.get(sessionId) === mine) this.sessionLocks.delete(sessionId)
    }
  }

  private async *runTurn(
    sessionId: string,
    prompt: string,
    history: ChatMessage[] | undefined,
    opts: AgentSendOpts | undefined,
  ): AsyncGenerator<string> {
    if (opts?.signal?.aborted) {
      yield composeProviderErrorNotice('aborted')
      return
    }
    const slashResult = this.tryHandleModelSlash(prompt, sessionId, opts)
    if (slashResult) {
      yield slashResult
      return
    }

    const overrideModel = opts?.model || this.sessionModelOverrides.get(sessionId)
    const effectiveOpts = overrideModel ? { ...(opts ?? {}), model: overrideModel } : opts
    const binding = await this.deps.resolveModel(effectiveOpts)
    if (opts?.signal?.aborted) {
      yield composeProviderErrorNotice('aborted')
      return
    }
    if (!binding) {
      yield '⚠️ Agim Agent：未配置可用的大模型 API（请在 /settings/llm 添加 API + API Key；角色绑定可选）'
      return
    }

    const env = new NodeExecutionEnv({ cwd: this.deps.sessionsRoot })
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: this.deps.sessionsRoot })

    // One JSONL file per agim session id. Reopen if it exists (pi owns the
    // history + leaf), else create a fresh one and seed prior agim history.
    // Cache the metadata so we don't rescan every session file each turn.
    let fresh = false
    let session: Awaited<ReturnType<typeof repo.open>>
    const cachedMeta = this.sessionMeta.get(sessionId)
    if (cachedMeta) {
      session = await repo.open(cachedMeta)
    } else {
      const found = (await repo.list()).find((m) => m.id === sessionId)
      if (found) {
        session = await repo.open(found)
      } else {
        session = await repo.create({ cwd: this.deps.sessionsRoot, id: sessionId })
        fresh = true
      }
    }
    const currentMeta = await session.getMetadata()
    this.sessionMeta.set(sessionId, currentMeta)
    // pi's NodeExecutionEnv creates directories/files with process umask
    // defaults (typically 0755/0644). Session transcripts can contain prompts,
    // tool arguments, and tool results, so match Agim's private-state posture.
    await Promise.all([
      chmod(dirname(currentMeta.path), 0o700).catch(() => {}),
      chmod(currentMeta.path, 0o600).catch(() => {}),
    ])
    if (opts?.signal?.aborted) {
      yield composeProviderErrorNotice('aborted')
      return
    }

    const toolSurface = this.deps.resolveTools?.(opts, sessionId) ?? null
    const tools = toolSurface
      ? agimToolsToPi(toolSurface.tools, toolSurface.dispatch, {
          traceId: opts?.traceId,
          parallelSafe: toolSurface.parallelSafe ?? this.deps.parallelSafe,
        })
      : []

    const systemPrompt = this.deps.resolveSystemPrompt?.(effectiveOpts, sessionId)
    const harness = new AgentHarness({
      env,
      session,
      model: binding.model,
      getApiKeyAndHeaders: binding.getApiKeyAndHeaders,
      tools,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(this.deps.streamOptions ? { streamOptions: this.deps.streamOptions } : {}),
    })

    // Keep the turn-local flag mutable: native_exit_plan_mode can explicitly
    // clear persistent Plan Mode mid-run, after which this same harness must
    // be able to execute the user-approved plan.
    let turnPlanMode = opts?.planMode === true
    const planDeny = this.deps.planModeMutatingTools ?? PLAN_MODE_DENY_TOOLS
    if (turnPlanMode || this.deps.resolveApprovalGate) {
      harness.on(
        'tool_call',
        async (ev: { toolName: string; toolCallId: string; input: unknown }) => {
          // Plan-mode hard deny (covers A2A-propagated plan-mode even without
          // an IM thread for the policy gate to read).
          if (turnPlanMode && planDeny.has(ev.toolName)) {
            return { block: true, reason: 'plan-mode: mutating tools are denied' }
          }
          // The dispatcher owns this approval-only handshake. Routing it
          // through the generic policy gate first creates a duplicate card
          // (or silently auto-approves the first gate).
          if (ev.toolName === PLAN_EXIT_TOOL_NAME) return undefined
          // agim policy gate: read-only / allow-list / deny-all, escalating to
          // an IM approval card when configured. Resolve per call so a
          // user-approved plan exit takes effect in the same harness turn.
          const gate = this.deps.resolveApprovalGate?.(opts, sessionId) ?? null
          if (gate) {
            const decision = await gate(
              { id: ev.toolCallId, name: ev.toolName, arguments: (ev.input ?? {}) as Record<string, unknown> },
              0,
              opts?.signal,
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
    const toolRuns: NativeToolRun[] = []
    harness.on('tool_result', (ev: NativeToolResultEvent) => {
      if (ev.toolName === PLAN_EXIT_TOOL_NAME && ev.isError !== true) {
        turnPlanMode = false
      }
      toolRounds += 1
      toolRuns.push({
        name: ev.toolName ?? 'unknown_tool',
        isError: ev.isError === true,
        preview: previewToolResult(ev),
      })
      if (toolRuns.length > 30) toolRuns.shift()
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

    // Proactive compaction (pi never auto-compacts): if the durable session has
    // grown past the model window minus reserve, summarize old history BEFORE
    // this turn so it neither overflows the context nor re-pays for the full
    // backlog every turn. Best-effort — a failed compaction must not block the
    // turn (it just runs with the larger context). Off via AGIM_NATIVE_COMPACTION=off.
    if (this.deps.compactionEnabled !== false && Number.isFinite(binding.model.contextWindow)) {
      try {
        const usage = getLastAssistantUsage(await session.getEntries())
        if (usage && shouldCompact(calculateContextTokens(usage), binding.model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
          await harness.compact()
        }
      } catch (err) {
        console.error('[native] compaction skipped:', err instanceof Error ? err.message : err)
      }
    }

    if (opts?.signal?.aborted) {
      yield composeProviderErrorNotice('aborted')
      return
    }

    // AgentHarness owns its run AbortController and prompt() does not accept an
    // external signal. Bridge the caller signal through abort(), while the
    // before_agent_start hook closes the small pre-controller race.
    const externalSignal = opts?.signal
    const unsubscribeBeforeStart = externalSignal
      ? harness.on('before_agent_start', () => {
          if (externalSignal.aborted) throw new Error('agent turn aborted before start')
          return undefined
        })
      : undefined
    const onExternalAbort = () => {
      void harness.abort().catch((err) => {
        console.error('[native] harness abort failed:', err instanceof Error ? err.message : err)
      })
    }
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })

    let result: Awaited<ReturnType<AgentHarness['prompt']>>
    try {
      const promptPromise = harness.prompt(prompt)
      // Covers abort between the final pre-check and listener registration.
      if (externalSignal?.aborted) onExternalAbort()
      result = await promptPromise
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      unsubscribeBeforeStart?.()
    }

    if (opts?.onUsage && result.usage) {
      opts.onUsage({
        tokensInput: result.usage.input,
        tokensOutput: result.usage.output,
        costUsd: result.usage.cost?.total,
      })
    }

    // Defensive: pi always returns a content array, but guard against a
    // malformed/empty shape so a provider hiccup degrades to a friendly notice
    // instead of throwing out of the turn.
    const text = (result.content ?? [])
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('')
    const hasText = text.trim().length > 0

    // Provider-level failure / abort. pi surfaces these as an assistant message
    // with stopReason 'error' | 'aborted' + errorMessage and (usually) empty
    // text — NOT as a thrown error. Detect it explicitly so a network drop is
    // reported as such (with a retry hint) instead of being misread as "the
    // model returned empty content".
    const providerFailed = result.stopReason === 'error'
    const providerAborted = result.stopReason === 'aborted'

    if (!hasText) {
      if (providerFailed || providerAborted) {
        yield composeProviderErrorNotice(providerFailed ? 'error' : 'aborted', result.errorMessage)
        return
      }
      if (stopReason) {
        yield stopReason === 'stuck_loop'
          ? '（检测到工具反复以相同参数失败的死循环，已提前停止）'
          : `（已达最大迭代步数 ${maxIter}，提前停止；可调高 AGIM_NATIVE_AGENT_MAX_ITER 后重试）`
        return
      }
      yield composeEmptyTurnRecap(toolRuns, tools.map((t) => t.name))
      return
    }

    // Non-empty answer. Append tool diagnostics; if the turn ALSO hit a
    // provider error after producing partial text, flag that the reply may be
    // incomplete and can be retried.
    let out = appendPartialToolDiagnostics(text, toolRuns, stopReason, maxIter)
    if (providerFailed) {
      out = `${out.trimEnd()}\n\n（注意：本轮因网络/服务中断提前结束，回复可能不完整，可回「重试」。）`
    }
    yield out
  }

  private tryHandleModelSlash(
    prompt: string,
    sessionId: string,
    opts: AgentSendOpts | undefined,
  ): string | null {
    const trimmed = prompt.trim()
    const match = trimmed.match(/^\/(models?|模型)(?:\s+(.+))?$/i)
    if (!match) return null

    const choices = this.deps.listModels?.() ?? []
    const current = opts?.model || this.sessionModelOverrides.get(sessionId) || choices[0]?.name || 'auto'
    const cmd = match[1].toLowerCase()
    const arg = (match[2] ?? '').trim()

    if (arg && /^(reset|default|auto|默认)$/i.test(arg)) {
      this.sessionModelOverrides.delete(sessionId)
      return '✅ Agim Agent 模型已恢复默认角色绑定。'
    }

    if (cmd === 'model' && !arg) {
      return `🧠 当前 Agim Agent 模型后端：\`${current}\`\n\n使用 /models 查看可用后端；使用 /model <后端名称> 切换。`
    }

    if (arg && /^refresh$/i.test(arg)) {
      return '✅ Agim Agent 模型列表无需刷新；它直接读取当前 LLM 配置。'
    }

    if (arg) {
      let picked = choices.find((c) => c.name === arg || c.model === arg)
      const indexMatch = arg.match(/^#?(\d+)$/)
      if (!picked && indexMatch) {
        const idx = Number.parseInt(indexMatch[1], 10) - 1
        if (idx >= 0 && idx < choices.length) picked = choices[idx]
      }
      if (!picked) {
        const hint = choices.length > 0 ? `\n\n可用：${choices.map((c) => `\`${c.name}\``).join('、')}` : ''
        return `⚠️ 找不到模型后端 \`${arg}\`。${hint}`
      }
      this.sessionModelOverrides.set(sessionId, picked.name)
      return `✅ Agim Agent 模型已切换：\`${picked.name}\`${picked.model ? `（${picked.model}）` : ''}`
    }

    if (choices.length === 0) {
      return '⚠️ 当前没有可用的大模型 API。请先到 /settings/llm 添加 API 和 API Key。'
    }

    const lines = [`📋 Agim Agent 可用模型后端 (${choices.length})`, '']
    choices.forEach((c, i) => {
      const detail = [c.providerType, c.model].filter(Boolean).join(':')
      const tag = c.name === current ? ' ⭐' : ''
      lines.push(`${String(i + 1).padStart(3, ' ')}. \`${c.name}\`${detail ? ` — ${detail}` : ''}${tag}`)
    })
    lines.push('', `当前：\`${current}\` ⭐`, '使用 /model <后端名称> 或 /model #序号 切换；使用 /model reset 恢复默认。')
    return lines.join('\n')
  }
}
