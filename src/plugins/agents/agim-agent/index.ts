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
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  FileError,
  getLastAssistantUsage,
  JsonlSessionRepo,
  shouldCompact,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { AgentHarnessStreamOptions, AgentMessage, Result } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'
import { chmod, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentAdapter, AgentAdapterKind, AgentSendOpts, AgentTurnOutcome, ChatMessage } from '../../../core/types.js'
import type { ApprovalGate } from '../../../core/llm/agent-loop.js'
import type { ToolDef } from '../../../core/llm/provider-base.js'
import type { ToolDispatcher } from '../../../core/llm/tool-dispatcher.js'
import { PLAN_EXIT_TOOL_NAME } from '../../../core/llm/plan-exit-dispatcher.js'
import { getActiveGoalState, getGoalsDatabaseForLedger } from '../../../core/goals.js'
import { hashWorkspaceScope } from '../../../core/goal-evidence.js'
import { defaultAgentCwd, resolveAgentCwd } from '../../../core/agent-cwd.js'
import { detectHallucinatedToolCall, isHallucinationDetectorOn } from '../../../core/llm/hallucination-detector.js'
import { resolveCriticMode, runGoalCritic } from '../../../core/llm/goal-critic.js'
import {
  isSemanticStuckLoop,
  resolveSemanticStuckLoopOn,
} from '../../../core/llm/agent-loop.js'
import { estimateCostUsd } from '../../../core/llm/model-catalog.js'
import { AGIM_PLAN_MODE_ALLOWED_TOOLS } from '../agim-agent-shared/tool-registry.js'
import { expandToolNameList } from '../../../core/llm/tool-names.js'
import { agimToolsToPi } from './tool-bridge.js'
import { failureSignature, stableStringify } from './loop-fingerprint.js'

/** Resolved LLM binding for one turn: a pi-ai Model + how to authenticate it. */
export interface NativeModelBinding {
  model: Model<string>
  /** Whether model.cost came from a known catalog entry. */
  costKnown?: boolean
  getApiKeyAndHeaders: () => Promise<{ apiKey: string; headers: Record<string, string> }>
}

export interface NativeModelChoice {
  name: string
  providerType?: string
  model?: string
}

export interface NativeAgentDeps {
  /** Adapter name to register under. Defaults to 'agim'. */
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
  /** Tools allowed under Plan Mode. Unknown tools fail closed. */
  planModeAllowedTools?: ReadonlySet<string>
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
  /** Hard cap on tool calls declared by assistant messages in one run. A batch
   *  that would exceed it is aborted before dispatch. Defaults to maxIterations. */
  maxToolCalls?: number
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
  /** Active AgentHarness loop watchdog in milliseconds, resolved per turn so
   *  goal-aware callers can extend it. Starts after optional compaction because
   *  pi 0.79.x does not expose a cancellable compaction signal. 0 disables. */
  resolveRunTimeoutMs?: (opts: AgentSendOpts | undefined) => number
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

class SecureNodeExecutionEnv extends NodeExecutionEnv {
  private readonly protectedSessionPaths = new Set<string>()

  protectSessionPath(path: string): void {
    this.protectedSessionPaths.add(path)
  }

  override async appendFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<Result<void, FileError>> {
    const absolute = await this.absolutePath(path)
    if (!absolute.ok) return absolute
    if (!this.protectedSessionPaths.has(absolute.value)) {
      return await super.appendFile(path, content)
    }
    // Open without O_CREAT. If the active JSONL is removed before or during
    // this operation, we either fail with ENOENT or keep writing only to the
    // already-open unlinked inode; we never recreate a headerless path.
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(absolute.value, 'r+')
      const stat = await handle.stat()
      const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content)
      await handle.write(bytes, 0, bytes.byteLength, stat.size)
      if (process.platform !== 'win32') await handle.chmod(0o600)
      return { ok: true, value: undefined }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const fileCode = code === 'ENOENT'
        ? 'not_found'
        : code === 'EACCES' || code === 'EPERM'
          ? 'permission_denied'
          : 'unknown'
      return {
        ok: false,
        error: new FileError(
          fileCode,
          fileCode === 'not_found'
            ? 'active pi session file was removed'
            : 'failed to append active pi session securely',
          absolute.value,
          err instanceof Error ? err : undefined,
        ),
      }
    } finally {
      try {
        await handle?.close()
      } catch { /* best-effort close */ }
    }
  }
}

interface NativeToolRun {
  name: string
  isError: boolean
  preview?: string
  /** Stable JSON of tool args — used by the semantic stuck-loop guard. */
  argsKey?: string
}

interface NativeToolResultEvent {
  toolCallId?: string
  toolName?: string
  input?: unknown
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
  details?: unknown
}

function fullToolResultText(ev: NativeToolResultEvent): string | undefined {
  const contentText = (ev.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (contentText) return contentText
  if (typeof ev.details === 'string' && ev.details.trim()) return ev.details.trim().replace(/\s+/g, ' ')
  if (ev.details !== undefined) return safeJson(ev.details).replace(/\s+/g, ' ')
  return undefined
}

function previewToolResult(ev: NativeToolResultEvent): string | undefined {
  return fullToolResultText(ev)?.slice(0, 180)
}

function previewToolInput(input: unknown): string | undefined {
  if (input == null) return undefined
  try {
    const raw = typeof input === 'string' ? input : JSON.stringify(input)
    return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw
  } catch {
    return undefined
  }
}

/** Heuristic: skill-ish tools get kind=skill in the web activity accordion. */
function classifyToolActivityKind(toolName: string): 'tool' | 'skill' {
  const n = toolName.toLowerCase()
  if (n.includes('skill') || n.startsWith('mcp__agim__skill')) return 'skill'
  return 'tool'
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

type NativeStopReason = 'max_iter' | 'max_tool_calls' | 'stuck_loop' | 'off_track' | 'hallucinated_tools'

/** Soft mid-turn critic cadence — mirrors agent-loop.ts. */
const CRITIC_MIN_TOOL_CALLS = 5
const CRITIC_EVERY_N = 5
const CRITIC_MAX_CALLS = 2

function composeHallucinatedToolsRecap(text: string, evidence?: string): string {
  const lines = [
    '⚠️ 模型口述了工具调用，但没有真正发出 tool call。',
    '本轮回复可能在假装执行操作，请当作未完成处理。',
  ]
  if (evidence) lines.push(`线索：${evidence.slice(0, 120)}`)
  lines.push('', '你可以回「重试」让我用真实工具再跑一遍。', '', '---', text.trimEnd())
  return lines.join('\n')
}

function composeOffTrackRecap(reason: string, redirect?: string): string {
  const lines = [
    '🧭 目标巡检判定本轮工具链偏离目标，已提前停止。',
    `原因：${reason.slice(0, 300)}`,
  ]
  if (redirect?.trim()) lines.push(`建议：${redirect.trim().slice(0, 300)}`)
  lines.push('', '你可以回「继续」按建议调整，或 /goal show 核对当前目标。')
  return lines.join('\n')
}

function composeLengthTruncationNotice(text: string): string {
  return `${text.trimEnd()}\n\n（注意：本轮回复因输出长度上限被截断，内容可能不完整；可回「继续」让我接着写。）`
}

function appendPartialToolDiagnostics(
  text: string,
  toolRuns: readonly NativeToolRun[],
  stopReason: NativeStopReason | null,
  maxIter: number,
  maxToolCalls: number,
): string {
  const diagnostics: string[] = []
  if (stopReason === 'stuck_loop') {
    diagnostics.push('检测到工具反复以相同参数失败，已提前停止；以上内容可能只覆盖已取得的信息。')
  } else if (stopReason === 'max_iter') {
    diagnostics.push(`已达到最大迭代步数 ${maxIter}，已提前停止；以上内容可能不完整。`)
  } else if (stopReason === 'max_tool_calls') {
    diagnostics.push(`已达到工具调用预算 ${maxToolCalls}，已提前停止；以上内容可能不完整。`)
  } else if (stopReason === 'off_track') {
    diagnostics.push('目标巡检判定偏离，已提前停止；以上内容可能不完整。')
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

function composeRunTimeoutNotice(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  return `⏱️ 本轮运行超过 ${seconds} 秒上限，已停止（未完成）。可缩小任务范围、设置长期目标后重试，或由管理员调整 AGIM_NATIVE_TURN_TIMEOUT_MS。`
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

function injectEphemeralContext(messages: AgentMessage[], context: string): AgentMessage[] {
  const trimmed = context.trim()
  if (!trimmed) return messages
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      idx = i
      break
    }
  }
  if (idx < 0) return messages
  const current = messages[idx]
  if (current?.role !== 'user') return messages
  const content = typeof current.content === 'string'
    ? `${trimmed}\n${current.content}`
    : [
        { type: 'text' as const, text: `${trimmed}\n` },
        ...current.content,
      ]
  const next = messages.slice()
  next[idx] = { ...current, content }
  return next
}

export class NativeAgentAdapter implements AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  readonly kind: AgentAdapterKind = 'in-process'
  readonly handlesAgimSkillsPrompt = true
  readonly handlesEphemeralContext = true

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
    this.name = deps.name ?? 'agim'
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
    let outcomeReported = false
    const reportOutcome = (outcome: AgentTurnOutcome) => {
      if (outcomeReported) return
      outcomeReported = true
      try { opts?.onOutcome?.(outcome) } catch { /* observer must not break turn */ }
    }
    const turnOpts: AgentSendOpts = {
      ...(opts ?? {}),
      onOutcome: reportOutcome,
    }
    // Serialize turns that share a session id (see sessionLocks). Chain this
    // turn behind whatever is already queued for the same id, and release the
    // slot when the turn (or an early consumer abandon) settles.
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const mine = prev.then(() => held)
    this.sessionLocks.set(sessionId, mine)
    // A cancelled waiter can return before `prev` settles. Keep its chained
    // promise in the map until the chain really drains; deleting it from the
    // waiter's finally would let a third turn overlap the still-active first.
    void mine.then(() => {
      if (this.sessionLocks.get(sessionId) === mine) this.sessionLocks.delete(sessionId)
    })
    try {
      const acquired = await waitForTurnSlot(prev, turnOpts.signal)
      if (!acquired) {
        reportOutcome({ status: 'aborted', providerFailure: false })
        yield composeProviderErrorNotice('aborted')
        return
      }
      yield* this.runTurn(sessionId, prompt, history, turnOpts)
      reportOutcome({ status: 'success', providerFailure: false })
    } catch (err) {
      if (turnOpts.signal?.aborted) {
        reportOutcome({ status: 'aborted', providerFailure: false })
        yield composeProviderErrorNotice('aborted')
        return
      }
      // Never fail silently: a thrown turn would otherwise reach the IM layer
      // as "no response". Surface the error so it's visible + diagnosable.
      const msg = err instanceof Error ? `${err.message}` : String(err)
      console.error('[agim-agent] turn failed:', err instanceof Error ? err.stack : err)
      reportOutcome({ status: 'error', providerFailure: true, error: msg })
      yield `⚠️ Agim Agent 本轮出错：${msg}`
    } finally {
      release()
    }
  }

  private async *runTurn(
    sessionId: string,
    prompt: string,
    history: ChatMessage[] | undefined,
    opts: AgentSendOpts | undefined,
  ): AsyncGenerator<string> {
    if (opts?.signal?.aborted) {
      opts.onOutcome?.({ status: 'aborted', providerFailure: false })
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
      opts.onOutcome?.({ status: 'aborted', providerFailure: false })
      yield composeProviderErrorNotice('aborted')
      return
    }
    if (!binding) {
      opts?.onOutcome?.({ status: 'error', providerFailure: false, error: 'no configured model backend' })
      yield '⚠️ Agim Agent：未配置可用的大模型 API（请在 /settings/llm 添加 API + API Key；角色绑定可选）'
      return
    }

    const env = new SecureNodeExecutionEnv({ cwd: this.deps.sessionsRoot })
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: this.deps.sessionsRoot })

    // One JSONL file per agim session id. Reopen if it exists (pi owns the
    // history + leaf), else create a fresh one and seed prior agim history.
    // Cache the metadata so we don't rescan every session file each turn.
    let fresh = false
    let session: Awaited<ReturnType<typeof repo.open>>
    const cachedMeta = this.sessionMeta.get(sessionId)
    if (cachedMeta) {
      try {
        session = await repo.open(cachedMeta)
      } catch (err) {
        // Retention, /new cleanup, or external repair may remove a cached
        // JSONL path. Invalidate once and rebuild from the repository view
        // instead of permanently failing every future turn for this id.
        this.sessionMeta.delete(sessionId)
        console.warn('[agim-agent] stale pi session metadata; reopening:', err instanceof Error ? err.message : err)
        const found = (await repo.list()).find((m) => m.id === sessionId)
        if (found) {
          session = await repo.open(found)
        } else {
          session = await repo.create({ cwd: this.deps.sessionsRoot, id: sessionId })
          fresh = true
        }
      }
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
    if (process.platform !== 'win32') {
      // Fail closed on POSIX: continuing after chmod failure would persist
      // sensitive prompts/tool output in a potentially world-readable file.
      await Promise.all([
        chmod(dirname(currentMeta.path), 0o700),
        chmod(currentMeta.path, 0o600),
      ])
    }
    env.protectSessionPath(currentMeta.path)
    if (opts?.signal?.aborted) {
      opts.onOutcome?.({ status: 'aborted', providerFailure: false })
      yield composeProviderErrorNotice('aborted')
      return
    }

    const toolSurface = this.deps.resolveTools?.(opts, sessionId) ?? null
    const goalScope = opts?.platform && opts.threadId
      ? { platform: opts.platform, channelId: opts.channelId ?? '', threadId: opts.threadId }
      : null
    const tools = toolSurface
      ? agimToolsToPi(toolSurface.tools, toolSurface.dispatch, {
          traceId: opts?.traceId,
          parallelSafe: toolSurface.parallelSafe ?? this.deps.parallelSafe,
          ...(goalScope ? {
            goalLedgerAvailable: () => getGoalsDatabaseForLedger() !== null,
            resolveGoalEvidence: () => {
              const state = getActiveGoalState(goalScope.platform, goalScope.channelId, goalScope.threadId)
              if (!state.available) throw new Error('goal state unavailable')
              const active = state.goal
              if (!active) return null
              const cwd = resolveAgentCwd('agim', opts ?? {}) || defaultAgentCwd('agim')
              return {
                goalId: active.id,
                goalVersion: active.version,
                traceId: opts?.traceId,
                workspaceScope: active.workspaceScope || hashWorkspaceScope(cwd),
              }
            },
          } : {}),
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
    const ephemeralContext = opts?.ephemeralContext?.trim() ?? ''
    /** Mid-turn soft steers (goal critic) — injected only via the context hook,
     *  never appended as durable user messages. */
    let ephemeralSteer = ''
    harness.on('context', (event) => {
      const combined = [ephemeralContext, ephemeralSteer].filter((part) => part.trim()).join('\n\n')
      if (!combined) return undefined
      return { messages: injectEphemeralContext(event.messages, combined) }
    })

    // Keep the turn-local flag mutable: agim_exit_plan_mode can explicitly
    // clear persistent Plan Mode mid-run, after which this same harness must
    // be able to execute the user-approved plan.
    let turnPlanMode = opts?.planMode === true
    let turnSignal = opts?.signal
    const planAllowed = expandToolNameList(
      this.deps.planModeAllowedTools ?? AGIM_PLAN_MODE_ALLOWED_TOOLS,
    )

    // Runaway guards. Declared early so tool_call preflight can share them.
    const maxIter = Math.max(1, Math.min(this.deps.maxIterations ?? DEFAULT_MAX_ITER, 100))
    const maxToolCalls = Math.max(1, this.deps.maxToolCalls ?? maxIter)
    let providerRequests = 0
    let declaredToolCalls = 0
    let dispatchedToolCalls = 0
    let usageInput = 0
    let usageOutput = 0
    let usageCost = 0
    let sawUsage = false
    let stopReason: NativeStopReason | null = null
    let requestLoopStop = () => {}
    let criticCallsFired = 0
    let lastCriticAtToolCalls = 0
    let offTrackSoftSteerUsed = false
    let offTrackDetail = ''
    let semanticStuckSoftSteerUsed = false
    let compactionCalls = 0
    const recentSigs: string[] = []
    const afterHookToolCallIds = new Set<string>()
    const toolRuns: NativeToolRun[] = []
    const mergeProviderUsage = (usage: {
      promptTokens?: number
      completionTokens?: number
      costUsd?: number
    } | undefined) => {
      if (!usage) return
      const input = usage.promptTokens ?? 0
      const output = usage.completionTokens ?? 0
      if (input <= 0 && output <= 0 && !(usage.costUsd && usage.costUsd > 0)) return
      sawUsage = true
      usageInput += input
      usageOutput += output
      if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
        usageCost += usage.costUsd
      }
    }
    const resolvedUsage = (): AgentTurnOutcome['usage'] | undefined => {
      if (!sawUsage && usageInput <= 0 && usageOutput <= 0 && !(usageCost > 0)) return undefined
      let costUsd = usageCost
      if (binding.costKnown === true && !(costUsd > 0) && (usageInput > 0 || usageOutput > 0)) {
        const estimated = estimateCostUsd(undefined, binding.model.id, {
          input: usageInput,
          output: usageOutput,
        })
        if (estimated != null) costUsd = estimated
      }
      return { tokensInput: usageInput, tokensOutput: usageOutput, costUsd }
    }
    const emitOutcome = (outcome: AgentTurnOutcome) => {
      const usage = resolvedUsage()
      const resolvedStop = outcome.stopReason
        ?? stopReason
        ?? undefined
      opts?.onOutcome?.({
        ...outcome,
        ...(resolvedStop ? { stopReason: resolvedStop } : {}),
        modelTurns: providerRequests,
        toolCalls: dispatchedToolCalls,
        auxModelCalls: compactionCalls + criticCallsFired,
        ...(usage ? { usage } : {}),
      })
    }

    const emitToolActivity = (
      step: {
        id: string
        kind?: 'tool' | 'skill' | 'status'
        label: string
        status: 'pending' | 'running' | 'success' | 'error' | 'denied'
        startedAt: number
        finishedAt?: number
        preview?: string
      },
    ): void => {
      if (!opts?.onToolActivity) return
      try {
        opts.onToolActivity({
          id: step.id,
          kind: step.kind ?? classifyToolActivityKind(step.label),
          label: step.label,
          status: step.status,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
          preview: step.preview,
        })
      } catch { /* observer must not break the harness loop */ }
    }
    const toolStartAt = new Map<string, number>()

    harness.on(
      'tool_call',
      async (ev: { toolName: string; toolCallId: string; input: unknown }) => {
        // Pre-dispatch tool-call budget: block before a parallel batch can
        // overrun maxToolCalls (message_end alone is too late).
        if (dispatchedToolCalls >= maxToolCalls) {
          stopReason = 'max_tool_calls'
          requestLoopStop()
          emitToolActivity({
            id: ev.toolCallId,
            label: ev.toolName,
            status: 'denied',
            startedAt: Date.now(),
            finishedAt: Date.now(),
            preview: `tool call budget exhausted (${maxToolCalls})`,
          })
          return { block: true, reason: `tool call budget exhausted (${maxToolCalls})` }
        }
        // Plan-mode hard deny (covers A2A-propagated plan-mode even without
        // an IM thread for the policy gate to read).
        if (turnPlanMode && !planAllowed.has(ev.toolName)) {
          emitToolActivity({
            id: ev.toolCallId,
            label: ev.toolName,
            status: 'denied',
            startedAt: Date.now(),
            finishedAt: Date.now(),
            preview: 'plan-mode: tool is not in the read/approval allowlist',
          })
          return { block: true, reason: 'plan-mode: tool is not in the read/approval allowlist' }
        }
        // agim policy gate: read-only / allow-list / deny-all, escalating to
        // an IM approval card when configured. Resolve per call so a
        // user-approved plan exit takes effect in the same harness turn.
        const gate = this.deps.resolveApprovalGate?.(opts, sessionId) ?? null
        if (gate) {
          const decision = await gate(
            { id: ev.toolCallId, name: ev.toolName, arguments: (ev.input ?? {}) as Record<string, unknown> },
            0,
            turnSignal,
          )
          if (decision === 'deny') {
            emitToolActivity({
              id: ev.toolCallId,
              label: ev.toolName,
              status: 'denied',
              startedAt: Date.now(),
              finishedAt: Date.now(),
              preview: `denied by policy: ${ev.toolName}`,
            })
            return { block: true, reason: `denied by policy: ${ev.toolName}` }
          }
        }
        dispatchedToolCalls += 1
        const startedAt = Date.now()
        toolStartAt.set(ev.toolCallId, startedAt)
        emitToolActivity({
          id: ev.toolCallId,
          label: ev.toolName,
          status: 'running',
          startedAt,
          preview: previewToolInput(ev.input),
        })
        return undefined
      },
    )

    const recordGuardOutcome = (
      toolName: string,
      input: unknown,
      isError: boolean,
      preview: string,
    ): boolean => {
      if (!isError) {
        recentSigs.length = 0
        return false
      }
      const sig = failureSignature(toolName, input, preview)
      recentSigs.push(sig)
      if (recentSigs.length > 3) recentSigs.shift()
      if (recentSigs.length === 3 && recentSigs.every((item) => item === sig)) {
        stopReason = 'stuck_loop'
        requestLoopStop()
        return true
      }
      return false
    }
    harness.on('before_provider_request', () => {
      // This hook runs before pi calls the transport, unlike turn_start. Throw
      // here so an over-budget iteration does not consume one extra request.
      if (stopReason) throw new Error(`native loop stopped: ${stopReason}`)
      if (providerRequests >= maxIter) {
        stopReason = 'max_iter'
        throw new Error(`native model-turn budget reached: ${maxIter}`)
      }
      providerRequests += 1
      return undefined
    })
    const unsubscribeBudget = harness.subscribe(async (event) => {
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        const calls = (event.message.content ?? []).filter((item) => item.type === 'toolCall')
        for (const result of event.toolResults) {
          if (!result.isError || afterHookToolCallIds.has(result.toolCallId)) continue
          const call = calls.find((item) => item.id === result.toolCallId)
          const preview = (result.content ?? [])
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join(' ')
          recordGuardOutcome(
            result.toolName ?? call?.name ?? 'unknown_tool',
            call?.arguments ?? {},
            true,
            preview,
          )
        }
        // Mid-turn goal critic (soft steer once, hard-stop on repeat).
        if (!stopReason && toolRuns.length > 0) {
          const activeGoal = goalScope
            ? getActiveGoalState(goalScope.platform, goalScope.channelId, goalScope.threadId).goal
            : null
          const criticMode = resolveCriticMode()
          const criticGateOpen = criticMode === 'always'
            || (criticMode === 'goal-only' && !!activeGoal?.title?.trim())
          if (
            criticGateOpen
            && toolRuns.length >= CRITIC_MIN_TOOL_CALLS
            && criticCallsFired < CRITIC_MAX_CALLS
            && toolRuns.length - lastCriticAtToolCalls >= CRITIC_EVERY_N
          ) {
            criticCallsFired += 1
            lastCriticAtToolCalls = toolRuns.length
            const verdict = await runGoalCritic({
              prompt,
              goalTitle: activeGoal?.title,
              goalBody: activeGoal?.body,
              recentToolCalls: toolRuns.slice(-10),
            }, { signal: turnSignal })
            mergeProviderUsage(verdict.usage)
            if (!verdict.onTrack) {
              offTrackDetail = verdict.redirect
                ? `${verdict.reason} || redirect: ${verdict.redirect}`
                : verdict.reason
              if (!offTrackSoftSteerUsed) {
                offTrackSoftSteerUsed = true
                ephemeralSteer = [
                  '[loop steer — goal critic]',
                  `Off-track: ${verdict.reason.slice(0, 400)}`,
                  verdict.redirect ? `Redirect: ${verdict.redirect.slice(0, 400)}` : '',
                  'Resume toward the active goal; do not continue the previous digression.',
                ].filter(Boolean).join('\n')
              } else {
                stopReason = 'off_track'
                requestLoopStop()
              }
            }
          }
        }
        // Cross-tool semantic stuck loop: different tools, same long arg.
        if (
          !stopReason
          && resolveSemanticStuckLoopOn()
          && toolRuns.length >= 3
        ) {
          const reports = toolRuns.flatMap((run) =>
            run.argsKey ? [{ name: run.name, argsKey: run.argsKey }] : [])
          if (isSemanticStuckLoop(reports)) {
            if (!semanticStuckSoftSteerUsed) {
              semanticStuckSoftSteerUsed = true
              ephemeralSteer = [
                ephemeralSteer,
                '[loop steer — semantic stuck]',
                'Recent tools repeated the same long argument while failing.',
                'Change approach: new query/path, or stop and summarize blockers.',
              ].filter(Boolean).join('\n')
            } else {
              stopReason = 'stuck_loop'
              requestLoopStop()
            }
          }
        }
        return
      }
      if (event.type !== 'message_end' || event.message.role !== 'assistant') return
      if (event.message.usage) {
        sawUsage = true
        usageInput += event.message.usage.input
          + event.message.usage.cacheRead
          + event.message.usage.cacheWrite
        usageOutput += event.message.usage.output
        usageCost += event.message.usage.cost?.total ?? 0
      }
      const batchCalls = (event.message.content ?? []).filter((c) => c.type === 'toolCall').length
      if (batchCalls === 0) return
      if (declaredToolCalls + batchCalls > maxToolCalls) {
        stopReason = 'max_tool_calls'
        requestLoopStop()
        return
      }
      declaredToolCalls += batchCalls
    })
    harness.on('tool_result', (ev: NativeToolResultEvent) => {
      if (ev.toolCallId) afterHookToolCallIds.add(ev.toolCallId)
      if (ev.toolName === PLAN_EXIT_TOOL_NAME && ev.isError !== true) {
        turnPlanMode = false
      }
      const preview = previewToolResult(ev)
      toolRuns.push({
        name: ev.toolName ?? 'unknown_tool',
        isError: ev.isError === true,
        preview,
        argsKey: stableStringify(ev.input ?? {}),
      })
      if (toolRuns.length > 30) toolRuns.shift()
      if (ev.toolCallId) {
        const startedAt = toolStartAt.get(ev.toolCallId) ?? Date.now()
        toolStartAt.delete(ev.toolCallId)
        emitToolActivity({
          id: ev.toolCallId,
          label: ev.toolName ?? 'unknown_tool',
          status: ev.isError === true ? 'error' : 'success',
          startedAt,
          finishedAt: Date.now(),
          preview,
        })
      }
      // Stuck-loop: same tool + key-order-stable args + normalized error class
      // failing 3× in a row. A success resets the window.
      if (recordGuardOutcome(
        ev.toolName ?? 'unknown_tool',
        ev.input,
        ev.isError === true,
        fullToolResultText(ev) ?? '',
      )) {
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
      const compactionController = new AbortController()
      const externalSignal = opts?.signal
      const forwardCompactionAbort = () => compactionController.abort(externalSignal?.reason)
      externalSignal?.addEventListener('abort', forwardCompactionAbort, { once: true })
      if (externalSignal?.aborted) forwardCompactionAbort()
      const compactionTimeoutMs = Math.max(1, this.deps.streamOptions?.timeoutMs ?? 120_000)
      const compactionTimer = setTimeout(() => {
        compactionController.abort(new Error(`compaction timed out after ${compactionTimeoutMs}ms`))
      }, compactionTimeoutMs)
      compactionTimer.unref?.()
      // AgentHarness 0.79.x otherwise passes `undefined` to compact(). Supply a
      // completed result from the hook so compaction honors caller/timeout abort.
      const unsubscribeCompaction = harness.on('session_before_compact', async (event) => {
        const auth = await binding.getApiKeyAndHeaders()
        const result = await compact(
          event.preparation,
          binding.model,
          auth.apiKey,
          auth.headers,
          event.customInstructions,
          compactionController.signal,
          undefined,
        )
        if (!result.ok) throw result.error
        return { compaction: result.value }
      })
      try {
        const usage = getLastAssistantUsage(await session.getEntries())
        if (usage && shouldCompact(calculateContextTokens(usage), binding.model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
          const compacted = await harness.compact()
          // Compaction summarization does not append an assistant usage
          // row — estimate from tokensBefore + summary length so /stats
          // still accounts for the auxiliary call.
          const approxOut = Math.max(1, Math.ceil(compacted.summary.length / 4))
          const approxIn = Math.max(approxOut, Math.min(compacted.tokensBefore, binding.model.contextWindow))
          sawUsage = true
          usageInput += approxIn
          usageOutput += approxOut
          compactionCalls += 1
          if (binding.costKnown) {
            const estimated = estimateCostUsd(undefined, binding.model.id, {
              input: approxIn,
              output: approxOut,
            })
            if (estimated != null) usageCost += estimated
          }
        }
      } catch (err) {
        console.error('[agim-agent] compaction skipped:', err instanceof Error ? err.message : err)
      } finally {
        clearTimeout(compactionTimer)
        externalSignal?.removeEventListener('abort', forwardCompactionAbort)
        unsubscribeCompaction()
      }
    }

    if (opts?.signal?.aborted) {
      unsubscribeBudget()
      opts.onOutcome?.({ status: 'aborted', providerFailure: false })
      yield composeProviderErrorNotice('aborted')
      return
    }

    // AgentHarness owns its run AbortController and prompt() does not accept an
    // external signal. Merge caller cancellation with an active-loop watchdog,
    // then bridge that signal through abort().
    const runController = new AbortController()
    requestLoopStop = () => {
      if (!runController.signal.aborted) {
        runController.abort(new Error(`native loop stopped: ${stopReason ?? 'guard'}`))
      }
    }
    const externalSignal = opts?.signal
    const forwardExternalAbort = () => runController.abort(externalSignal?.reason)
    externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true })
    if (externalSignal?.aborted) forwardExternalAbort()

    const runTimeoutMs = Math.max(0, this.deps.resolveRunTimeoutMs?.(opts) ?? 0)
    let runTimedOut = false
    const timeoutTimer = runTimeoutMs > 0
      ? setTimeout(() => {
          runTimedOut = true
          runController.abort(new Error(`native run timed out after ${runTimeoutMs}ms`))
        }, runTimeoutMs)
      : undefined
    timeoutTimer?.unref?.()
    turnSignal = runController.signal

    const unsubscribeBeforeStart = harness.on('before_agent_start', () => {
      if (turnSignal?.aborted) throw new Error('agent turn aborted before start')
      return undefined
    })
    const onRunAbort = () => {
      void harness.abort().catch((err) => {
        console.error('[agim-agent] harness abort failed:', err instanceof Error ? err.message : err)
      })
    }
    turnSignal.addEventListener('abort', onRunAbort, { once: true })

    let result: Awaited<ReturnType<AgentHarness['prompt']>>
    try {
      const promptPromise = harness.prompt(prompt)
      // Covers abort between the final pre-check and listener registration.
      if (turnSignal.aborted) onRunAbort()
      result = await promptPromise
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      externalSignal?.removeEventListener('abort', forwardExternalAbort)
      runController.signal.removeEventListener('abort', onRunAbort)
      unsubscribeBeforeStart()
      unsubscribeBudget()
    }

    if (opts?.onUsage && sawUsage) {
      const usage = resolvedUsage()
      if (usage) {
        opts.onUsage({
          tokensInput: usage.tokensInput,
          tokensOutput: usage.tokensOutput,
          costUsd: usage.costUsd,
        })
      }
    }
    opts?.onCostMetadata?.({ known: binding.costKnown === true })

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
    const providerAborted = result.stopReason === 'aborted' || runController.signal.aborted
    const providerFailed = result.stopReason === 'error' && !providerAborted

    if (!hasText) {
      if (runTimedOut) {
        emitOutcome({ status: 'timeout', providerFailure: false, error: `run timeout ${runTimeoutMs}ms` })
        yield composeRunTimeoutNotice(runTimeoutMs)
        return
      }
      if (stopReason) {
        emitOutcome({ status: 'partial', providerFailure: false, error: stopReason, stopReason })
        yield stopReason === 'stuck_loop'
          ? '（检测到工具反复以相同参数失败的死循环，已提前停止）'
          : stopReason === 'max_tool_calls'
            ? `（已达工具调用预算 ${maxToolCalls}，提前停止；可调高 AGIM_NATIVE_AGENT_MAX_TOOL_CALLS 后重试）`
            : stopReason === 'off_track'
              ? composeOffTrackRecap(
                offTrackDetail.split(' || redirect: ')[0] ?? offTrackDetail,
                offTrackDetail.includes(' || redirect: ')
                  ? offTrackDetail.split(' || redirect: ').slice(1).join(' || redirect: ')
                  : undefined,
              )
            : `（已达最大迭代步数 ${maxIter}，提前停止；可调高 AGIM_NATIVE_AGENT_MAX_ITER 后重试）`
        return
      }
      if (providerFailed || providerAborted) {
        emitOutcome({
          status: providerFailed ? 'error' : 'aborted',
          providerFailure: providerFailed,
          error: result.errorMessage,
        })
        yield composeProviderErrorNotice(providerFailed ? 'error' : 'aborted', result.errorMessage)
        return
      }
      emitOutcome({ status: 'error', providerFailure: false, error: 'empty model response', stopReason: 'empty' })
      yield composeEmptyTurnRecap(toolRuns, tools.map((t) => t.name))
      return
    }

    // Non-empty answer. Flag narrated-but-not-emitted tool calls so we don't
    // ship a lie as a successful turn.
    if (
      !stopReason
      && !providerFailed
      && !providerAborted
      && !runTimedOut
      && toolRuns.length === 0
      && tools.length > 0
      && isHallucinationDetectorOn()
    ) {
      const det = detectHallucinatedToolCall({
        text,
        toolNames: tools.map((t) => t.name),
        emittedToolCallCount: 0,
      })
      if (det.hallucinated) {
        emitOutcome({
          status: 'partial',
          providerFailure: false,
          error: 'hallucinated_tools',
          stopReason: 'hallucinated_tools',
        })
        yield composeHallucinatedToolsRecap(text, det.evidence)
        return
      }
    }

    // Non-empty answer. Append tool diagnostics; if the turn ALSO hit a
    // provider error after producing partial text, flag that the reply may be
    // incomplete and can be retried.
    let out = appendPartialToolDiagnostics(text, toolRuns, stopReason, maxIter, maxToolCalls)
    if (result.stopReason === 'length' && !stopReason && !providerFailed && !providerAborted) {
      out = composeLengthTruncationNotice(out)
      emitOutcome({ status: 'partial', providerFailure: false, error: 'length', stopReason: 'length' })
    } else if (opts?.signal?.aborted) {
      emitOutcome({ status: 'aborted', providerFailure: false, error: 'aborted after partial response' })
    } else if (runTimedOut) {
      emitOutcome({ status: 'timeout', providerFailure: false, error: `run timeout ${runTimeoutMs}ms` })
      out = `${out.trimEnd()}\n\n（注意：${composeRunTimeoutNotice(runTimeoutMs)}）`
    } else if (providerFailed) {
      emitOutcome({ status: 'partial', providerFailure: true, error: result.errorMessage })
      out = `${out.trimEnd()}\n\n（注意：本轮因网络/服务中断提前结束，回复可能不完整，可回「重试」。）`
    } else if (providerAborted) {
      emitOutcome({ status: 'partial', providerFailure: false, error: 'aborted after partial response' })
    } else if (stopReason === 'off_track') {
      emitOutcome({ status: 'partial', providerFailure: false, error: 'off_track', stopReason: 'off_track' })
      out = `${out.trimEnd()}\n\n${composeOffTrackRecap(
        offTrackDetail.split(' || redirect: ')[0] ?? offTrackDetail,
        offTrackDetail.includes(' || redirect: ')
          ? offTrackDetail.split(' || redirect: ').slice(1).join(' || redirect: ')
          : undefined,
      )}`
    } else if (stopReason) {
      emitOutcome({ status: 'partial', providerFailure: false, error: stopReason, stopReason })
    } else {
      emitOutcome({ status: 'success', providerFailure: false })
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
