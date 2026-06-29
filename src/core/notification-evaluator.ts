// notification-evaluator — D+ Stage 1 follow-up (#9 in the plan).
//
// Purpose: keep agent-initiated push messages from spamming users with
// "no news" updates. A configured 'evaluator' LLM backend reads the
// outbound text and decides whether it carries actionable information
// worth interrupting the user for; routine / empty / pure-housekeeping
// chatter is silently dropped.
//
// Design constraints (deliberate):
//
//   1. **Default off**. Most operators ship without this; flipping the
//      gate on for everyone could silently lose a notification a user
//      cares about. Opt-in via AGIM_NOTIFICATION_EVALUATOR=on (and a
//      configured 'evaluator' role in llmBackends/llmRoles).
//
//   2. **Scope: agent-initiated only**. User asked a question → the
//      reply always goes through, no gate. Only paths where an agent
//      or scheduled job decides _on its own_ to ping the user are
//      gated: push_message MCP tool, POST /api/notify, future heartbeat
//      ticks, etc. Configurable per-source via
//      AGIM_NOTIFICATION_EVALUATOR_SOURCES.
//
//   3. **Fail-open**. LLM call fails → deliver. Verdict parse fails →
//      deliver. Provider unconfigured → deliver. Dropping a message
//      because the evaluator infrastructure broke would erode trust
//      and is the opposite of what users want. Only an explicit
//      `deliver: false` verdict from the LLM suppresses.
//
//   4. **Audit suppressions, not deliveries**. Every silenced message
//      lands as a `notification.suppress` audit_events row so operators
//      can spot-check what the gate is doing. Deliveries already show
//      up in outbox + invocations.
//
//   5. **Card payloads always pass**. Interactive cards (approval,
//      recovery, choice cards) have explicit user actions and must
//      reach the chat; this gate is text-only.

import { logger as rootLogger } from './logger.js'
import { tryIntrospect } from './llm/index.js'
import { logAuditEvent } from './audit-log.js'

const log = rootLogger.child({ component: 'notification-evaluator' })

/**
 * Sources the evaluator may gate. New sources land in AGIM_NOTIFICATION_EVALUATOR_SOURCES
 * comma-list (precedence: env > built-in default below).
 */
export type NotificationSource =
  | 'push'         // mcp__agim__push_message (agent-initiated)
  | 'notify'       // POST /api/notify (external monitoring / CI / cron)
  | 'reminder'     // /remind delivery (LLM-polished reminder)
  | 'heartbeat'    // Stage 1 follow-up: heartbeat tick result (future #1)

/** Built-in defaults — agent-initiated paths only. Users with reminders
 *  on a fixed schedule generally WANT the chime, so we leave reminder
 *  off by default; same for /api/notify (operator likely already
 *  filters upstream). Operators can opt these in via env. */
const DEFAULT_GATED_SOURCES: ReadonlySet<NotificationSource> = new Set<NotificationSource>([
  'push',
  'heartbeat',
])

/** Hard upper bound on prompt size; truncates the inbound text before
 *  asking the LLM. Cheap models with 4k context will choke otherwise,
 *  and a 16k novel doesn't help the verdict accuracy anyway. */
const MAX_TEXT_CHARS = 2000

/** Time budget for the evaluator call. Shorter than distill's 30s
 *  because the path is user-facing latency-sensitive: a push that takes
 *  10s to land feels broken. If the cheap model can't decide in 6s,
 *  fail open and deliver. */
const EVALUATOR_TIMEOUT_MS = 6_000

export interface EvaluationInput {
  /** Where this outbound originated. Required — drives the
   *  gating-source decision. */
  source: NotificationSource
  /** Text body about to be delivered. Card payloads should NOT call
   *  this gate at all (see design constraint #5). */
  text: string
  /** Target IM thread string `platform:channelId:threadId` — used only
   *  for audit row context, not the verdict prompt. */
  targetThread: string
  /** Optional caller context for push_message — propagates into the
   *  audit row so operators can trace "which agent kept spamming". */
  caller?: { platform: string; userId: string; agent?: string }
  /** Trace id to thread the audit row to the originating request. */
  traceId?: string
}

export interface EvaluationDecision {
  /** true = let the message through; false = silently drop. */
  shouldDeliver: boolean
  /** One-line operator-facing reason. Surfaces in audit_events.details
   *  for every suppression and in the structured log for every call. */
  reason: string
  /** Which code path produced the decision.
   *   - 'disabled' — AGIM_NOTIFICATION_EVALUATOR not 'on'
   *   - 'source-excluded' — gate on, but this source isn't in the
   *     gated-sources set
   *   - 'no-backend' — gate on, source gated, but no 'evaluator' role
   *     in the LLM registry
   *   - 'fail-open' — gate ran, LLM call / parse failed; deliver anyway
   *   - 'evaluator' — gate ran, LLM returned a definitive verdict */
  via: 'disabled' | 'source-excluded' | 'no-backend' | 'fail-open' | 'evaluator'
}

/**
 * Decide whether `input.text` is worth delivering. Always returns a
 * decision — never throws. Callers that get `shouldDeliver: false`
 * MUST silently drop the message; the audit row + log line already
 * recorded the suppression.
 */
export async function evaluateNotification(input: EvaluationInput): Promise<EvaluationDecision> {
  // 1. Master switch.
  if (!isEvaluatorEnabled()) {
    return { shouldDeliver: true, reason: 'evaluator disabled', via: 'disabled' }
  }

  // 2. Source-scope check.
  const gated = gatedSources()
  if (!gated.has(input.source)) {
    return {
      shouldDeliver: true,
      reason: `source "${input.source}" not in gated set`,
      via: 'source-excluded',
    }
  }

  // 3. Trivial-input fast path. Don't spend an LLM call on the empty
  // string; deliver and let the sink reject downstream if needed.
  const cleanText = input.text.trim()
  if (cleanText.length === 0) {
    return { shouldDeliver: true, reason: 'empty body', via: 'fail-open' }
  }

  // 4. Ask the LLM.
  const prompt = buildPrompt(input.source, cleanText)
  const result = await tryIntrospect({
    role: 'evaluator',
    prompt,
    timeoutMs: EVALUATOR_TIMEOUT_MS,
    temperature: 0,
  })
  if (!result) {
    return {
      shouldDeliver: true,
      reason: 'no evaluator backend configured (or call failed)',
      via: 'no-backend',
    }
  }

  // 5. Parse verdict. Defensive — the cheap model occasionally wraps
  //    in ```json fences or adds prose despite instructions.
  const verdict = parseVerdict(result.text)
  if (verdict === null) {
    log.warn({
      event: 'evaluator.unparseable_verdict',
      source: input.source,
      backend: result.backendName,
      rawPreview: result.text.slice(0, 200),
    })
    return {
      shouldDeliver: true,
      reason: `unparseable verdict from ${result.backendName}`,
      via: 'fail-open',
    }
  }

  // 6. Definitive verdict — log + audit only on suppression.
  if (!verdict.deliver) {
    try {
      logAuditEvent({
        traceId: input.traceId,
        eventType: 'notification.suppress',
        actor: input.caller
          ? `${input.caller.platform}:${input.caller.userId}`
          : 'system',
        target: input.targetThread,
        outcome: 'ok',
        details: {
          source: input.source,
          backend: result.backendName,
          providerType: result.providerType,
          textLen: cleanText.length,
          reason: verdict.reason.slice(0, 200),
          agent: input.caller?.agent ?? '',
        },
      })
    } catch { /* audit best-effort, must never break the caller */ }
    log.info({
      event: 'evaluator.suppressed',
      source: input.source,
      backend: result.backendName,
      reason: verdict.reason,
      targetThread: input.targetThread,
    })
    return { shouldDeliver: false, reason: verdict.reason, via: 'evaluator' }
  }

  // Definitive deliver — keep an INFO log so operators can audit the
  // signal-to-noise ratio of the gate over time.
  log.info({
    event: 'evaluator.delivered',
    source: input.source,
    backend: result.backendName,
    reason: verdict.reason,
    targetThread: input.targetThread,
  })
  return { shouldDeliver: true, reason: verdict.reason, via: 'evaluator' }
}

// ---------------------------------------------------------------------
// Env / config helpers (cheap to call on every evaluation; the values
// can flip at runtime via systemd Environment= reload).
// ---------------------------------------------------------------------

function isEvaluatorEnabled(): boolean {
  return (process.env.AGIM_NOTIFICATION_EVALUATOR || '').toLowerCase() === 'on'
}

function gatedSources(): Set<NotificationSource> {
  const raw = process.env.AGIM_NOTIFICATION_EVALUATOR_SOURCES
  if (!raw) return new Set(DEFAULT_GATED_SOURCES)
  const next = new Set<NotificationSource>()
  for (const item of raw.split(',')) {
    const v = item.trim().toLowerCase()
    if (v === 'push' || v === 'notify' || v === 'reminder' || v === 'heartbeat') {
      next.add(v)
    }
  }
  return next
}

// ---------------------------------------------------------------------
// Prompt + parsing
// ---------------------------------------------------------------------

function buildPrompt(source: NotificationSource, text: string): string {
  const truncated = text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n...[truncated ${text.length - MAX_TEXT_CHARS} chars]`
    : text
  return [
    '你是一名"通知评估员"。你只输出一行 JSON，格式严格如下，**没有 markdown 围栏 / 解释 / 多余文字**：',
    '',
    '{"deliver": true|false, "reason": "<≤30字中英文混合理由>"}',
    '',
    '判断规则：',
    '- deliver=true：包含**新结论、状态变化、报警、用户需要采取行动的信息**',
    '- deliver=true：含数字/时间/价格/事件的实质性更新',
    '- deliver=false：纯客套（"好的"/"完成了"/"暂无新信息"/"任务结束"）',
    '- deliver=false：与上一次对话重复 / 完全没有用户视角下的价值',
    '- 不确定时倾向 true（防误删）',
    '',
    `来源: ${source}`,
    '消息正文：',
    '"""',
    truncated,
    '"""',
    '',
    '现在输出 JSON：',
  ].join('\n')
}

interface VerdictJson {
  deliver: boolean
  reason: string
}

function parseVerdict(raw: string): VerdictJson | null {
  // Strip optional ```json fences and surrounding prose, then try to
  // locate the JSON object substring.
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  s = s.slice(start, end + 1)
  let obj: unknown
  try { obj = JSON.parse(s) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (typeof o.deliver !== 'boolean') return null
  const reason = typeof o.reason === 'string' ? o.reason : ''
  return { deliver: o.deliver, reason: reason.slice(0, 200) }
}
