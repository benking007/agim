// heartbeat — periodic proactive wake-up loop (P0 #1).
//
// For each enabled binding (one per IM thread; see heartbeat-store), the
// scheduler runs a three-phase tick:
//
//   1. DECIDE  — ask the cheap LLM (role 'cheap', via tryIntrospect)
//                whether the binding body has any action to do *right
//                now*. Returns {run, summary} JSON; on parse/LLM
//                failure we fail OPEN (always execute) so the loop
//                doesn't silently go dark just because the LLM is
//                misconfigured.
//
//   2. EXECUTE — when DECIDE said run, hand the body + the LLM's
//                rephrased summary to the user's IM CLI agent
//                (Claude Code / Codex / OpenCode) via the existing
//                agent-helper layer. The agent does the actual work
//                (look up a price, summarise an inbox, …) and returns
//                free-form text.
//
//   3. EVALUATE — push the agent's text through the
//                  notification-evaluator gate (source='heartbeat',
//                  default-gated). Routine / empty output gets
//                  silently dropped + audit-logged; actionable info
//                  reaches the user via the sink.
//
// Each tick's outcome is stamped onto the binding row so /heartbeat
// show can render "last status: delivered 5 min ago" or "last status:
// skipped — nothing to do". Failures never throw out of tickOnce(); a
// stuck agent or LLM problem must not crash the daemon.

import { logger as rootLogger } from './logger.js'
import { sink } from './message-sink.js'
import { callHelperAgent } from './agent-helper.js'
import { tryIntrospect } from './llm/index.js'
import { evaluateNotification } from './notification-evaluator.js'
import {
  listDueBindings, recordTick,
  type HeartbeatRow,
} from './heartbeat-store.js'

const log = rootLogger.child({ component: 'heartbeat' })

/** Default 60s — short enough that a 5-min binding fires within ~1
 *  scheduler tick of due; long enough that the SQLite scan + Promise
 *  fan-out doesn't show up on /api/metrics CPU. */
const DEFAULT_TICK_INTERVAL_MS = 60_000

/** When `AGIM_HEARTBEAT_ENABLED` is unset we still **load** the store
 *  (so /heartbeat bind / show works for setup) but DON'T start the
 *  scheduler. That matches the project's "opt-in everywhere" policy
 *  for things that spend LLM budget on the user's behalf. */
function isSchedulerEnabled(): boolean {
  const raw = (process.env.AGIM_HEARTBEAT_ENABLED || '').toLowerCase()
  return raw === 'on' || raw === '1' || raw === 'true'
}

function tickIntervalMs(): number {
  const raw = process.env.AGIM_HEARTBEAT_TICK_INTERVAL_MS
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 5_000 && n <= 600_000) return n
  }
  return DEFAULT_TICK_INTERVAL_MS
}

// ---------------------------------------------------------------------
// Decide phase
// ---------------------------------------------------------------------

interface DecideVerdict {
  run: boolean
  summary: string
}

function buildDecidePrompt(body: string): string {
  return [
    '你是一个 heartbeat 调度器。下面是用户登记的"想让我定期帮他盯着"的事项清单。',
    '现在请判断**此刻**有没有需要执行的事项；如果有，把它简短改写成一段后台 agent 能直接照做的任务描述。',
    '',
    '严格输出 JSON，**无 markdown 围栏 / 解释 / 多余字段**：',
    '',
    '{"run": true|false, "summary": "<≤200字中英文混合的任务描述；run=false 时填空字符串>"}',
    '',
    '判断规则：',
    '- 时间敏感的事项（每天 8 点 / 收盘前 / 周一上午）只在窗口内 run=true',
    '- 持续型监控（"盯着 600519 涨停"）→ 每次 tick 都 run=true',
    '- 完全不到时间 / 已经过期 / 无内容 → run=false，summary=""',
    '- 拿不准时倾向 run=true（防漏）',
    '',
    '事项清单：',
    '"""',
    body,
    '"""',
    '',
    '现在输出 JSON：',
  ].join('\n')
}

function parseDecide(raw: string): DecideVerdict | null {
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
  if (typeof o.run !== 'boolean') return null
  const summary = typeof o.summary === 'string' ? o.summary : ''
  return { run: o.run, summary: summary.slice(0, 400) }
}

/**
 * The decide phase. Returns either a verdict from the LLM or a synthetic
 * fail-open verdict that runs the binding (because skipping silently
 * would erode trust in heartbeats more than running unnecessarily).
 */
async function decideRun(row: HeartbeatRow): Promise<{
  verdict: DecideVerdict
  via: 'llm' | 'fail-open-no-backend' | 'fail-open-llm-error' | 'fail-open-parse-error'
}> {
  const result = await tryIntrospect({
    role: 'cheap',
    prompt: buildDecidePrompt(row.body),
    timeoutMs: 10_000,
    temperature: 0,
  })
  if (!result) {
    return {
      verdict: { run: true, summary: row.body.slice(0, 400) },
      via: 'fail-open-no-backend',
    }
  }
  const parsed = parseDecide(result.text)
  if (!parsed) {
    log.warn({
      event: 'heartbeat.decide.unparseable',
      id: row.id, backend: result.backendName,
      preview: result.text.slice(0, 200),
    })
    return {
      verdict: { run: true, summary: row.body.slice(0, 400) },
      via: 'fail-open-parse-error',
    }
  }
  return { verdict: parsed, via: 'llm' }
}

// ---------------------------------------------------------------------
// Execute phase
// ---------------------------------------------------------------------

function buildExecutePrompt(row: HeartbeatRow, decideSummary: string): string {
  return [
    'You are running a periodic heartbeat task for the user. Be terse, factual, and OUTPUT ONLY the user-facing result text (no preamble, no "OK, here\'s what I found", no markdown fences around the whole answer).',
    '',
    'If after investigation there is genuinely no new information to share, reply EXACTLY:',
    '   NO_UPDATE',
    '(the supervisor will silently drop NO_UPDATE before notifying the user.)',
    '',
    'Otherwise reply with the actionable update only, ≤ 800 chars.',
    '',
    `## Heartbeat charter (last set by the user)\n${row.body}`,
    '',
    `## Concrete task for THIS tick\n${decideSummary || row.body.slice(0, 400)}`,
  ].join('\n')
}

const NO_UPDATE_SENTINELS = new Set([
  'no_update',
  'NO_UPDATE',
  'no update',
  'NO UPDATE',
])

/**
 * Run the user's CLI agent on the decided task. Returns null when no
 * agent could be picked or the helper call failed; runForBinding will
 * record this as 'no-agent' or 'failed' accordingly.
 */
async function executeTask(row: HeartbeatRow, decideSummary: string): Promise<string | null> {
  const composed = buildExecutePrompt(row, decideSummary)
  const out = await callHelperAgent({
    platform: row.platform,
    channelId: row.channelId,
    threadId: row.threadId,
    systemPrompt: 'You execute heartbeat tasks. Output only the result body.',
    userPrompt: composed,
    timeoutMs: 60_000,
    maxOutputChars: 2_000,
  })
  return out
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export interface RunResult {
  status: 'skipped' | 'delivered' | 'suppressed' | 'no-agent' | 'failed'
  reason: string
  /** Populated only when status='delivered'. */
  deliveredText?: string
  /** Populated when status='delivered' or 'suppressed' so /heartbeat
   *  run-now can print "the gate / sink got this much". */
  rawAgentOutput?: string
}

/**
 * Single binding tick. ALL exceptions caught + logged + stamped onto
 * the row; never throws. Returns the result so the slash command's
 * `/heartbeat run-now` can show it back to the user synchronously.
 */
export async function runForBinding(row: HeartbeatRow): Promise<RunResult> {
  if (!row.enabled) {
    return { status: 'skipped', reason: 'binding disabled' }
  }

  // ── DECIDE ────────────────────────────────────────────────────────
  const decide = await decideRun(row)
  if (!decide.verdict.run) {
    const reason = `decide=skip (via ${decide.via})`
    recordTick({ id: row.id, status: 'skipped', reason })
    log.info({ event: 'heartbeat.skipped', id: row.id, via: decide.via })
    return { status: 'skipped', reason }
  }

  // ── EXECUTE ───────────────────────────────────────────────────────
  let agentOut: string | null = null
  try {
    agentOut = await executeTask(row, decide.verdict.summary)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ event: 'heartbeat.execute_failed', id: row.id, err: msg })
    recordTick({ id: row.id, status: 'failed', reason: `execute: ${msg}` })
    return { status: 'failed', reason: msg }
  }
  if (agentOut === null) {
    const reason = 'no agent available or helper returned null'
    recordTick({ id: row.id, status: 'no-agent', reason })
    log.info({ event: 'heartbeat.no_agent', id: row.id })
    return { status: 'no-agent', reason }
  }

  const trimmedOut = agentOut.trim()
  if (trimmedOut === '' || NO_UPDATE_SENTINELS.has(trimmedOut)) {
    const reason = 'agent returned NO_UPDATE / empty'
    recordTick({ id: row.id, status: 'skipped', reason })
    log.info({ event: 'heartbeat.no_update', id: row.id })
    return { status: 'skipped', reason, rawAgentOutput: trimmedOut }
  }

  // ── EVALUATE ──────────────────────────────────────────────────────
  const verdict = await evaluateNotification({
    source: 'heartbeat',
    text: trimmedOut,
    targetThread: `${row.platform}:${row.channelId}:${row.threadId}`,
    caller: { platform: row.platform, userId: row.userId, agent: 'heartbeat' },
  })
  if (!verdict.shouldDeliver) {
    const reason = `evaluator suppressed: ${verdict.reason} (via ${verdict.via})`
    recordTick({ id: row.id, status: 'suppressed', reason })
    return {
      status: 'suppressed',
      reason,
      rawAgentOutput: trimmedOut,
    }
  }

  // ── DELIVER ───────────────────────────────────────────────────────
  try {
    await sink.deliver({
      platform: row.platform,
      channelId: row.channelId,
      threadId: row.threadId,
      payload: trimmedOut,
      kind: 'text',
      priority: 'normal',
      source: 'system',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ event: 'heartbeat.deliver_failed', id: row.id, err: msg })
    recordTick({ id: row.id, status: 'failed', reason: `deliver: ${msg}` })
    return { status: 'failed', reason: msg }
  }
  const reason = `delivered via ${decide.via}`
  recordTick({
    id: row.id,
    status: 'delivered',
    reason,
    deliveredText: trimmedOut,
  })
  log.info({
    event: 'heartbeat.delivered',
    id: row.id,
    bytes: trimmedOut.length,
  })
  return { status: 'delivered', reason, deliveredText: trimmedOut, rawAgentOutput: trimmedOut }
}

/**
 * One scheduler pass. Picks up to 50 due bindings and runs them
 * sequentially; concurrent ticks on the same scheduler are intentional
 * (avoids stampedes on the user's agent, keeps memory bounded). Returns
 * a summary so tests can assert on it.
 */
export async function tickOnce(): Promise<{ scanned: number; results: Record<string, number> }> {
  const due = listDueBindings()
  const results: Record<string, number> = {}
  for (const row of due) {
    let r: RunResult
    try {
      r = await runForBinding(row)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ event: 'heartbeat.run_unhandled', id: row.id, err: msg })
      recordTick({ id: row.id, status: 'failed', reason: `unhandled: ${msg}` })
      r = { status: 'failed', reason: msg }
    }
    results[r.status] = (results[r.status] ?? 0) + 1
  }
  if (due.length > 0) {
    log.info({ event: 'heartbeat.tick.done', scanned: due.length, results })
  }
  return { scanned: due.length, results }
}

// ---------------------------------------------------------------------
// Scheduler lifecycle (called from cli.ts at boot)
// ---------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null

export function startHeartbeatScheduler(): void {
  if (timer) return
  if (!isSchedulerEnabled()) {
    log.info({ event: 'heartbeat.scheduler.disabled' },
      'AGIM_HEARTBEAT_ENABLED unset; /heartbeat bind/show still works but no automatic ticks')
    return
  }
  const period = tickIntervalMs()
  log.info({ event: 'heartbeat.scheduler.start', periodMs: period })
  timer = setInterval(() => {
    void tickOnce().catch((err) => {
      log.warn({ event: 'heartbeat.tick.unhandled', err: String(err) })
    })
  }, period)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as { unref: () => void }).unref()
  }
}

export function stopHeartbeatScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Reflect current scheduler state for /heartbeat status output. */
export function schedulerInfo(): { enabled: boolean; running: boolean; periodMs: number } {
  return {
    enabled: isSchedulerEnabled(),
    running: timer !== null,
    periodMs: tickIntervalMs(),
  }
}
