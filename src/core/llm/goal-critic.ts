// goal-critic — periodic semantic check that a native turn is still on
// track for the user's goal.
//
// Motivation (v1.2.98):
//   v1.2.95's stuck-loop detector catches the MECHANICAL case (same
//   tool, same isError, same preview — model is literally re-running a
//   failing call). It cannot tell when the model is making
//   slightly-different-but-still-pointless calls — e.g. retrying a
//   failing SQL with cosmetic tweaks, or chasing a wrong-tree branch
//   for ten turns. That's a SEMANTIC failure mode and only an LLM can
//   judge it.
//
//   The critic is a single cheap LLM call run periodically inside the
//   agent loop. It sees:
//     - the original user prompt for this turn
//     - the active long-task goal (if any — gives a longer-horizon
//       anchor than the per-turn prompt)
//     - a compact transcript of recent tool calls + brief previews
//   It returns: { onTrack, reason, redirect? }
//
//   The loop honours `onTrack:false` by breaking with a new
//   finishReason='off_track'. native then renders a structured recap
//   that names the suspected drift + the critic's redirect suggestion,
//   instead of letting the model burn the iteration cap or push more
//   garbage at the user.
//
// What this module is NOT:
//   - Not a tool-call gate (it doesn't approve / deny individual
//     calls). It runs OUT-OF-BAND, sees the trail of completed calls,
//     and only fires occasionally.
//   - Not a replacement for the mechanical stuck-loop detector
//     (v1.2.95). They're complementary: mechanical first (free + fast),
//     semantic second (LLM cost + latency).
//
// Cost model:
//   - Default OFF unless the env switch is set OR active Focus-backed
//     goal state is present on the thread. Daily-driver short turns don't
//     pay anything.
//   - Throttled by a per-turn min-iteration gate (default 5) AND a
//     per-turn max-call gate (default 2) so a single turn can't fire
//     the critic more than twice.
//   - Uses `llmRoles.cheap` (or whatever AGIM_NATIVE_CRITIC_ROLE points
//     at) — operators can plug a small model. Falls back to the same
//     provider as the turn if `cheap` is unset.

import { logger as rootLogger } from '../logger.js'
import { getAnyProvider, getProvider } from './registry.js'
import type { LlmProvider, LlmMessage, LlmUsage } from './provider-base.js'

const log = rootLogger.child({ component: 'goal-critic' })

export interface CriticInput {
  /** The user's original prompt for the current turn. Optional but
   *  highly recommended — the critic needs SOMETHING to anchor "what
   *  was the goal" against. If both prompt AND goalTitle are empty,
   *  the critic refuses to judge (returns onTrack=true). */
  prompt?: string
  /** The thread's active long-task goal title + body. Stronger anchor
   *  than per-turn prompt when present — survives across turns. */
  goalTitle?: string
  goalBody?: string
  /** Compact transcript of the latest tool calls. Capped at the last
   *  ~10 by the caller; the critic prompt re-caps to 300 chars per
   *  preview anyway. */
  recentToolCalls: ReadonlyArray<{
    name: string
    isError: boolean
    preview?: string
  }>
}

export interface CriticVerdict {
  onTrack: boolean
  reason: string
  /** When onTrack=false, the critic's one-line suggestion for what to
   *  do differently. May be empty if the critic couldn't think of one. */
  redirect?: string
  /** Provider/model used for the critic call, for audit. */
  modelUsed?: string
  /** Token/cost usage from the critic provider call, when reported. */
  usage?: LlmUsage
}

export interface CompletionCriticInput {
  goalTitle: string
  goalBody?: string
  evidence: ReadonlyArray<{ name: string; preview: string }>
}

export interface CompletionCriticVerdict {
  completed: boolean
  reason: string
  modelUsed?: string
}

const DEFAULT_SYSTEM_PROMPT =
  '你是 agim 的 goal-keeper（目标守门员）。任务：判断"刚才那一串工具调用"是否还在为用户的原始目标做事，' +
  '还是已经偏离 / 在死循环里磨。' +
  '\n\n判定准则：' +
  '\n  · 工具结果有进展（信息量增加 / 接近目标） → onTrack=true' +
  '\n  · 工具反复失败、模型只做表面调整（参数微改 / 同一个错继续撞） → onTrack=false' +
  '\n  · 已偏离原始话题（在做 user 没要的事） → onTrack=false' +
  '\n  · 不确定 / 信息不足 → onTrack=true（保守，避免误杀）' +
  '\n\n输出**只能**是合法 JSON，结构：' +
  '\n  { "onTrack": boolean, "reason": "一句中文，≤ 60 字", "redirect": "如果偏离，建议什么新方向，≤ 60 字；不偏离填空字符串" }' +
  '\n\n不要解释、不要寒暄、不要 markdown 围栏。直接给 JSON。'

/** v1.2.99 (CR finding A2): three-valued knob.
 *  - `off` / `0` / `false`  → hard kill, never fire critic
 *  - `always` / `on` / `1` / `true` → fire whenever any anchor exists
 *    (prompt OR active goal)
 *  - anything else (incl. unset) → fire ONLY when an active long-task
 *    goal exists. Per-turn prompts alone don't trigger.
 *
 *  This matches the cost story documented in CHANGELOG: day-to-day
 *  single-turn chats pay nothing; the critic is reserved for
 *  long-horizon work signalled by Focus-backed goal state. */
export type CriticMode = 'off' | 'always' | 'goal-only'
export function resolveCriticMode(): CriticMode {
  const raw = (process.env.AGIM_NATIVE_CRITIC || '').toLowerCase().trim()
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off'
  if (raw === 'always' || raw === 'on' || raw === '1' || raw === 'true') return 'always'
  return 'goal-only'
}
function resolveCriticEnabled(): boolean {
  return resolveCriticMode() !== 'off'
}

function resolveCriticRole(): string {
  const raw = process.env.AGIM_NATIVE_CRITIC_ROLE?.trim()
  return raw || 'cheap'
}

/** Pick the critic provider: env-named role → cheap role → null.
 *  Returns null when no usable provider — caller treats that as
 *  "critic disabled this turn" and skips. */
export function pickCriticProvider(force = false): { provider: LlmProvider; role: string } | null {
  if (!force && !resolveCriticEnabled()) return null
  const role = resolveCriticRole()
  const p = getProvider(role)
  if (p) return { provider: p, role }
  // Operator named a role that isn't configured — try the default
  // cheap role as a last resort, otherwise give up.
  if (role !== 'cheap') {
    const fallback = getProvider('cheap')
    if (fallback) return { provider: fallback, role: 'cheap' }
  }
  const native = getProvider('native-chat')
  if (native) return { provider: native, role: 'native-chat' }
  const any = getAnyProvider()
  if (any) return { provider: any, role: 'auto' }
  return null
}

function buildTranscript(calls: CriticInput['recentToolCalls']): string {
  if (calls.length === 0) return '(本轮还未调用任何工具)'
  return calls.map((c, i) => {
    const status = c.isError ? '✗ FAILED' : '✓'
    const preview = (c.preview ?? '').trim().slice(0, 300).replace(/\s+/g, ' ')
    return `${i + 1}. [${status}] ${c.name}\n   ${preview}${(c.preview?.length ?? 0) > 300 ? '…' : ''}`
  }).join('\n')
}

/**
 * Run one goal-critic check. ALWAYS returns a verdict — never throws.
 * Provider errors / unparseable JSON / no anchor → `onTrack=true` with
 * a reason explaining why we couldn't judge, so the caller treats them
 * as "no veto" rather than a misleading break.
 */
export async function runGoalCritic(
  input: CriticInput,
  opts: { signal?: AbortSignal; timeoutMs?: number; force?: boolean } = {},
): Promise<CriticVerdict> {
  const haveAnchor = !!(input.prompt?.trim() || input.goalTitle?.trim())
  if (!haveAnchor) {
    return { onTrack: true, reason: 'no prompt/goal anchor to judge against' }
  }
  const picked = pickCriticProvider(opts.force)
  if (!picked) {
    return { onTrack: true, reason: 'critic disabled (no provider for cheap role / AGIM_NATIVE_CRITIC=off)' }
  }

  const transcript = buildTranscript(input.recentToolCalls)
  const userBlock = [
    input.prompt ? `[用户本轮原始 prompt]\n${input.prompt.trim().slice(0, 1000)}` : null,
    (input.goalTitle || input.goalBody)
      ? `[active long-task goal]\n${input.goalTitle ?? ''}${input.goalBody ? `\n${input.goalBody.slice(0, 1000)}` : ''}`
      : null,
    `[最近 ${input.recentToolCalls.length} 次工具调用]\n${transcript}`,
    '[请按 system prompt 给出 JSON 判定]',
  ].filter(Boolean).join('\n\n')

  const messages: LlmMessage[] = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: userBlock },
  ]

  try {
    const r = await picked.provider.chat(messages, {
      timeoutMs: opts.timeoutMs ?? 30_000,
      signal: opts.signal,
    })
    const text = (r.text ?? '').trim()
    if (!text) {
      return { onTrack: true, reason: 'critic returned empty text', modelUsed: r.modelUsed, usage: r.usage }
    }
    const parsed = tryParseJson(text)
    if (!parsed) {
      log.warn({ event: 'goal-critic.parse_failed', raw: text.slice(0, 200) })
      return { onTrack: true, reason: 'critic JSON unparseable', modelUsed: r.modelUsed, usage: r.usage }
    }
    return {
      onTrack: parsed.onTrack !== false,  // default true on weird type
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '',
      redirect: typeof parsed.redirect === 'string' ? parsed.redirect.slice(0, 120) : undefined,
      modelUsed: r.modelUsed,
      usage: r.usage,
    }
  } catch (err) {
    log.warn({
      event: 'goal-critic.threw',
      err: err instanceof Error ? err.message : String(err),
    })
    return { onTrack: true, reason: `critic call threw — letting loop continue` }
  }
}

/** Hard completion proof review. Evidence and recap are untrusted model/tool
 * data; malformed output and provider failures fail closed. */
export async function runGoalCompletionCritic(
  input: CompletionCriticInput,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CompletionCriticVerdict> {
  const picked = pickCriticProvider(true)
  if (!picked) return { completed: false, reason: 'no completion critic provider configured' }
  const system =
    'You are Agim\'s completion verifier. Decide whether the supplied TOOL EVIDENCE proves that every material acceptance criterion in the GOAL is completed now. ' +
    'Evidence previews are fixed server-generated attestations, not tool text. ' +
    'Progress, relevance, intent, or a plausible claim are not proof of completion. When uncertain, missing criteria, stale state, or only partial evidence: completed=false. ' +
    'Output only strict JSON: {"completed":true|false,"reason":"<=120 chars"}.'
  const payload = {
    goal: {
      title: input.goalTitle.slice(0, 500),
      body: (input.goalBody ?? '').slice(0, 2000),
    },
    evidence: input.evidence.slice(0, 16).map((item) => ({
      tool: item.name.slice(0, 120),
      preview: item.preview.slice(0, 1000),
    })),
  }
  try {
    const response = await picked.provider.chat([
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ], {
      timeoutMs: opts.timeoutMs ?? 30_000,
      signal: opts.signal,
    })
    const parsed = tryParseJson(response.text ?? '') as
      | { completed?: unknown; reason?: unknown }
      | null
    if (!parsed || typeof parsed.completed !== 'boolean') {
      return {
        completed: false,
        reason: 'completion critic returned malformed verdict',
        modelUsed: response.modelUsed,
      }
    }
    return {
      completed: parsed.completed,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '',
      modelUsed: response.modelUsed,
    }
  } catch (err) {
    return {
      completed: false,
      reason: `completion critic failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Strip code-fence + parse JSON. Some models still wrap responses
 *  even when told not to; we accept either bare JSON or ```json…```. */
function tryParseJson(text: string): { onTrack?: unknown; reason?: unknown; redirect?: unknown } | null {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const obj = JSON.parse(stripped)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj
    return null
  } catch {
    return null
  }
}
