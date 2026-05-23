// router-compare — Stage 5 A/B evaluator.
//
// Lets the operator run the SAME prompt through two backends side by
// side and see what each produced, how long they took, and (when a
// judge role is configured) which the judge LLM preferred. The two
// backends can be of three kinds:
//
//   1. A CLI / native AgentAdapter ("agent:claude-code", "agent:native")
//   2. A native LLM role             ("llm:cheap", "llm:evaluator")
//   3. A native LLM backend by name  ("backend:deepseek-chat")
//
// All three share the same Result envelope so the formatter stays
// dumb. Failures DON'T throw — we return them in the Result envelope
// with `ok: false` so the slash command can render both sides even
// when one panicked.
//
// The judge step is optional. When `judgeRole` is set AND that role
// has a configured native backend AND both sides returned non-empty
// output, we ask the judge to pick A / B / tie + give a one-sentence
// reason. Judge cost / latency is reported separately so it doesn't
// pollute the per-side numbers.

import { getProvider, getProviderByName, type LlmRole } from './llm/registry.js'
import { tryIntrospect } from './llm/introspection.js'
import { callHelperAgent } from './agent-helper.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'router-compare' })

/** Wall-clock cap per side. Generous because either side might call
 *  out to a tool-using CLI agent. Caller can override. */
const DEFAULT_PER_SIDE_TIMEOUT_MS = 60_000
/** Output character cap per side. Bounds the prompt budget for the
 *  optional judge step and keeps the IM bubble manageable. */
const DEFAULT_MAX_OUTPUT_CHARS = 4_000
/** Hard cap on judge prompt overhead so the eval prompt doesn't
 *  itself become the most expensive thing per call. */
const JUDGE_PROMPT_BUDGET_CHARS = 8_000

export type BackendKind = 'agent' | 'llm' | 'backend'

export interface BackendRef {
  kind: BackendKind
  /** For kind='agent' this is the AgentAdapter name; for kind='llm' a
   *  role; for kind='backend' a backend name from llmBackends. */
  name: string
}

export interface CompareInput {
  prompt: string
  systemPrompt?: string
  a: BackendRef
  b: BackendRef
  /** When set + the role has a configured backend, ask the judge to
   *  pick a winner. Common choices: 'evaluator' or 'cheap'. */
  judgeRole?: LlmRole
  /** Per-side wall-clock cap (overrides default 60s). */
  perSideTimeoutMs?: number
  /** Per-side output character cap (default 4 000). */
  maxOutputChars?: number
  /** Optional IM context for agent-kind sides. callHelperAgent needs
   *  platform/channel/thread to resolve sticky sessions; without them
   *  it picks the first registered agent. Defaults are fine for CLI
   *  use; slash-command callers should pass through their context. */
  platform?: string
  channelId?: string
  threadId?: string
}

export interface SideResult {
  ref: BackendRef
  ok: boolean
  /** Output text (truncated to maxOutputChars; empty when ok=false). */
  text: string
  /** Wall-clock latency in ms. Populated even on failure. */
  durationMs: number
  /** Best-effort token counts. Native LLM sides have full numbers;
   *  CLI / native AgentAdapter sides only have what their adapter
   *  surfaces — usually null. */
  tokensIn?: number
  tokensOut?: number
  /** Human-readable error message when ok=false. */
  error?: string
}

export interface JudgeVerdict {
  /** 'a' | 'b' | 'tie'. 'inconclusive' when the judge didn't return a
   *  parseable answer. */
  pick: 'a' | 'b' | 'tie' | 'inconclusive'
  /** Short rationale from the judge (≤ 200 chars). */
  reason: string
  backendName: string
  durationMs: number
  tokensIn?: number
  tokensOut?: number
}

export interface CompareResult {
  a: SideResult
  b: SideResult
  judge?: JudgeVerdict
  /** Echoed back so callers can log the exact request shape. */
  input: CompareInput
}

/**
 * Run the comparison. Never throws — every failure mode lands in the
 * SideResult.ok=false branch with a populated `error` field.
 */
export async function runRouterCompare(input: CompareInput): Promise<CompareResult> {
  if (!input.prompt?.trim()) {
    throw new Error('runRouterCompare: prompt is required (non-empty)')
  }
  const [a, b] = await Promise.all([
    runSide(input.a, input),
    runSide(input.b, input),
  ])
  const out: CompareResult = { a, b, input }
  if (input.judgeRole && a.ok && b.ok && a.text && b.text) {
    const verdict = await runJudge(input.judgeRole, input.prompt, a, b)
    if (verdict) out.judge = verdict
  }
  log.info({
    event: 'router.compare.done',
    aKind: input.a.kind, aName: input.a.name, aOk: a.ok, aMs: a.durationMs,
    bKind: input.b.kind, bName: input.b.name, bOk: b.ok, bMs: b.durationMs,
    judge: out.judge?.pick,
  })
  return out
}

// ─── side runners ──────────────────────────────────────────────────

async function runSide(ref: BackendRef, input: CompareInput): Promise<SideResult> {
  const start = Date.now()
  const max = input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const timeout = input.perSideTimeoutMs ?? DEFAULT_PER_SIDE_TIMEOUT_MS
  try {
    if (ref.kind === 'agent') return await runAgentSide(ref, input, start, max, timeout)
    if (ref.kind === 'llm') return await runLlmRoleSide(ref, input, start, max, timeout)
    if (ref.kind === 'backend') return await runLlmBackendSide(ref, input, start, max, timeout)
    return {
      ref, ok: false, text: '', durationMs: Date.now() - start,
      error: `unknown backend kind: ${ref.kind}`,
    }
  } catch (err) {
    return {
      ref, ok: false, text: '', durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function runAgentSide(
  ref: BackendRef, input: CompareInput, start: number, max: number, timeout: number,
): Promise<SideResult> {
  const text = await callHelperAgent({
    platform: input.platform ?? 'compare',
    channelId: input.channelId ?? 'compare',
    threadId: input.threadId ?? 'compare',
    systemPrompt: input.systemPrompt ?? 'You are a helpful assistant. Answer concisely.',
    userPrompt: input.prompt,
    timeoutMs: timeout,
    maxOutputChars: max,
    agentName: ref.name,
  })
  if (text === null) {
    return {
      ref, ok: false, text: '', durationMs: Date.now() - start,
      error: `agent "${ref.name}" returned no output (not registered or timed out)`,
    }
  }
  return {
    ref, ok: true, text: clip(text, max), durationMs: Date.now() - start,
  }
}

async function runLlmRoleSide(
  ref: BackendRef, input: CompareInput, start: number, max: number, timeout: number,
): Promise<SideResult> {
  const result = await tryIntrospect({
    role: ref.name,
    prompt: input.prompt,
    system: input.systemPrompt,
    timeoutMs: timeout,
  })
  if (!result) {
    return {
      ref, ok: false, text: '', durationMs: Date.now() - start,
      error: `no native LLM backend wired for role "${ref.name}"`,
    }
  }
  return {
    ref, ok: true, text: clip(result.text, max),
    durationMs: result.durationMs,
    tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
  }
}

async function runLlmBackendSide(
  ref: BackendRef, input: CompareInput, start: number, max: number, timeout: number,
): Promise<SideResult> {
  const provider = getProviderByName(ref.name)
  if (!provider) {
    return {
      ref, ok: false, text: '', durationMs: Date.now() - start,
      error: `no LLM backend named "${ref.name}"`,
    }
  }
  const r = await provider.chat([{ role: 'user', content: input.prompt }], {
    system: input.systemPrompt,
    timeoutMs: timeout,
  })
  return {
    ref, ok: true, text: clip(r.text, max),
    durationMs: Date.now() - start,
    tokensIn: r.usage.promptTokens, tokensOut: r.usage.completionTokens,
  }
}

// ─── judge ─────────────────────────────────────────────────────────

async function runJudge(
  judgeRole: LlmRole, userPrompt: string, a: SideResult, b: SideResult,
): Promise<JudgeVerdict | null> {
  const provider = getProvider(judgeRole)
  if (!provider) {
    log.info({ event: 'router.compare.judge_skipped', reason: 'no_provider_for_role', role: judgeRole })
    return null
  }
  const startedAt = Date.now()
  const judgeSystem = (
    'You are an impartial judge comparing two assistant outputs to the SAME user prompt. ' +
    'Pick the better answer. Reply with EXACTLY one JSON object: ' +
    '{"pick":"a"|"b"|"tie","reason":"<single sentence, max 200 chars>"}. ' +
    'No prose outside the JSON, no markdown fences.'
  )
  const aClip = clip(a.text, Math.floor(JUDGE_PROMPT_BUDGET_CHARS / 2))
  const bClip = clip(b.text, Math.floor(JUDGE_PROMPT_BUDGET_CHARS / 2))
  const judgePrompt = (
    `USER PROMPT:\n${clip(userPrompt, 2_000)}\n\n` +
    `--- assistant A (${a.ref.kind}:${a.ref.name}) ---\n${aClip}\n\n` +
    `--- assistant B (${b.ref.kind}:${b.ref.name}) ---\n${bClip}\n\n` +
    `Pick the better answer or say tie.`
  )
  const result = await tryIntrospect({
    role: judgeRole,
    prompt: judgePrompt,
    system: judgeSystem,
    timeoutMs: 30_000,
    temperature: 0,
  })
  if (!result) return null
  const verdict = parseJudgePick(result.text)
  return {
    pick: verdict.pick,
    reason: verdict.reason,
    backendName: result.backendName,
    durationMs: Date.now() - startedAt,
    tokensIn: result.usage.promptTokens,
    tokensOut: result.usage.completionTokens,
  }
}

interface ParsedPick { pick: JudgeVerdict['pick']; reason: string }

/** Best-effort parser. We tolerate models that wrap JSON in
 *  ```json fences``` (despite the system-prompt instruction) and
 *  models that emit `"pick":"A"` uppercase. Unknown shape →
 *  pick:'inconclusive'. */
function parseJudgePick(raw: string): ParsedPick {
  const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim()
  try {
    const obj = JSON.parse(cleaned) as { pick?: unknown; reason?: unknown }
    const pickRaw = typeof obj.pick === 'string' ? obj.pick.toLowerCase().trim() : ''
    const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 200) : ''
    if (pickRaw === 'a' || pickRaw === 'b' || pickRaw === 'tie') {
      return { pick: pickRaw, reason: reason || '(no reason)' }
    }
  } catch { /* ignore — fall through to inconclusive */ }
  // Last-ditch substring sniff for models that ignored the format.
  const lower = raw.toLowerCase()
  if (/(?:^|[^a-z])a is better|prefer a|answer a/.test(lower)) return { pick: 'a', reason: clip(raw, 200) }
  if (/(?:^|[^a-z])b is better|prefer b|answer b/.test(lower)) return { pick: 'b', reason: clip(raw, 200) }
  if (/\btie\b|equal/.test(lower)) return { pick: 'tie', reason: clip(raw, 200) }
  return { pick: 'inconclusive', reason: clip(raw, 200) }
}

// ─── helpers ───────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated to ${max} chars by router-compare]`
}

/** Parse "agent:claude-code" / "llm:cheap" / "backend:deepseek-chat"
 *  into a typed BackendRef. Returns null when the spec is malformed —
 *  caller should surface a user-facing error. */
export function parseBackendRef(spec: string): BackendRef | null {
  const m = spec.match(/^(agent|llm|backend):([A-Za-z0-9_-]+)$/)
  if (!m) return null
  return { kind: m[1] as BackendKind, name: m[2] }
}

/**
 * Render a CompareResult into a markdown body for IM / CLI display.
 * Section ordering: header, A, B, judge verdict (if present).
 */
export function formatCompareResult(r: CompareResult): string {
  const lines: string[] = []
  lines.push('🆚 **/router compare**')
  lines.push(`prompt: \`${clip(r.input.prompt, 200)}\``)
  lines.push('')
  lines.push(renderSide('A', r.a))
  lines.push('')
  lines.push(renderSide('B', r.b))
  if (r.judge) {
    lines.push('')
    lines.push(renderJudge(r.judge))
  }
  return lines.join('\n')
}

function renderSide(label: 'A' | 'B', s: SideResult): string {
  const head = `**${label}** \`${s.ref.kind}:${s.ref.name}\` · ${s.durationMs}ms` +
    (s.tokensIn !== undefined ? ` · tokens ${s.tokensIn}→${s.tokensOut ?? '?'}` : '') +
    (s.ok ? '' : ' · ❌')
  if (!s.ok) return `${head}\n> ${s.error ?? 'unknown error'}`
  return `${head}\n${s.text}`
}

function renderJudge(j: JudgeVerdict): string {
  const flag = ({ a: '🅰 A wins', b: '🅱 B wins', tie: '🤝 tie', inconclusive: '🤷 inconclusive' })[j.pick]
  return `**Judge** (${j.backendName}, ${j.durationMs}ms): ${flag}\n> ${j.reason}`
}
