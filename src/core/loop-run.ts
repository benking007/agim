// loop-run — Phase C Loop session store (Focus-bound).
// SSOT: docs/architecture/loop-engineering.md
// Persistence: ~/.agim/loops/<threadKey>.json (fail-soft).

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'
import {
  focusOff,
  getFocusOn,
  setFocus,
} from './focus.js'

const log = rootLogger.child({ component: 'loop-run' })

function loopsDir(): string {
  return process.env.AGIM_LOOPS_DIR ?? join(AGIM_HOME, 'loops')
}

export type LoopStatus = 'running' | 'observing' | 'paused' | 'ended'
export type LoopDecision = 'continue' | 'revise' | 'stop'

export interface LoopVerdict {
  decision: LoopDecision
  summary: string
  reasons?: string[]
  nextHint?: string
}

export interface LoopTimelineEntry {
  at: number
  kind: 'executor' | 'observer' | 'user' | 'system'
  summary: string
}

export interface LoopRun {
  id: string
  platform: string
  channelId: string
  threadId: string
  focusSnapshot: string
  /** true = this Loop opened/turned on Focus → end with focus off */
  openedFocus: boolean
  status: LoopStatus
  endReason?: 'stop_verdict' | 'user_stop' | 'limit' | 'focus_off' | 'error'
  round: number
  maxRounds: number
  startNote?: string
  createdAt: number
  updatedAt: number
  lastVerdict?: LoopVerdict
  timeline: LoopTimelineEntry[]
}

function threadKey(platform: string, channelId: string, threadId: string): string {
  const raw = `${platform}__${channelId}__${threadId}`
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180)
}

function pathFor(platform: string, channelId: string, threadId: string): string {
  return join(loopsDir(), `${threadKey(platform, channelId, threadId)}.json`)
}

function ensureDir(): void {
  const dir = loopsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readRun(platform: string, channelId: string, threadId: string): LoopRun | null {
  const p = pathFor(platform, channelId, threadId)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as LoopRun
    if (!raw || typeof raw !== 'object' || !raw.id) return null
    return raw
  } catch (err) {
    log.warn({ event: 'loop.read_failed', err: String(err) })
    return null
  }
}

function writeRun(run: LoopRun): boolean {
  try {
    ensureDir()
    const p = pathFor(run.platform, run.channelId, run.threadId)
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(run, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, p)
    return true
  } catch (err) {
    log.warn({ event: 'loop.write_failed', err: String(err) })
    return false
  }
}

function defaultMaxRounds(): number {
  const raw = (process.env.AGIM_LOOP_MAX_ROUNDS ?? '').trim()
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return Math.min(n, 100)
  }
  return 12
}

function pushTimeline(run: LoopRun, kind: LoopTimelineEntry['kind'], summary: string): void {
  run.timeline.push({ at: Date.now(), kind, summary: summary.slice(0, 500) })
  if (run.timeline.length > 80) run.timeline = run.timeline.slice(-80)
}

export function getLoopRun(
  platform: string,
  channelId: string,
  threadId: string,
): LoopRun | null {
  return readRun(platform, channelId, threadId)
}

export function getActiveLoop(
  platform: string,
  channelId: string,
  threadId: string,
): LoopRun | null {
  const run = readRun(platform, channelId, threadId)
  if (!run) return null
  if (run.status === 'ended') return null
  return run
}

export type StartLoopResult =
  | { ok: true; run: LoopRun; path: 'A' | 'B' }
  | { ok: false; error: string }

/**
 * Path A: Focus already on → start; optional note; openedFocus=false.
 * Path B: Focus not on → require text; set+on Focus; openedFocus=true.
 */
export function startLoop(input: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  text?: string
}): StartLoopResult {
  const existing = getActiveLoop(input.platform, input.channelId, input.threadId)
  if (existing) {
    return { ok: false, error: 'already_running' }
  }

  const focus = getFocusOn(input.platform, input.channelId, input.threadId)
  const text = (input.text ?? '').trim()
  let openedFocus = false
  let path: 'A' | 'B'

  if (focus) {
    path = 'A'
    // text is start note only — do not replace Focus body
  } else {
    if (!text) return { ok: false, error: 'need_text' }
    const set = setFocus({
      platform: input.platform,
      channelId: input.channelId,
      threadId: input.threadId,
      userId: input.userId,
      title: text,
    })
    if (!set) return { ok: false, error: 'focus_set_failed' }
    openedFocus = true
    path = 'B'
  }

  const focusNow = getFocusOn(input.platform, input.channelId, input.threadId)
  if (!focusNow) return { ok: false, error: 'focus_required' }

  const now = Date.now()
  const run: LoopRun = {
    id: randomUUID(),
    platform: input.platform,
    channelId: input.channelId,
    threadId: input.threadId,
    focusSnapshot: focusNow.title + (focusNow.body ? `\n${focusNow.body}` : ''),
    openedFocus,
    status: 'running',
    round: 1,
    maxRounds: defaultMaxRounds(),
    startNote: path === 'A' && text ? text : undefined,
    createdAt: now,
    updatedAt: now,
    timeline: [],
  }
  pushTimeline(run, 'user', path === 'A' ? `loop start (path A)${text ? `: ${text}` : ''}` : `loop start (path B): ${text}`)
  if (!writeRun(run)) return { ok: false, error: 'persist_failed' }
  return { ok: true, run, path }
}

function endLoopInternal(
  run: LoopRun,
  endReason: NonNullable<LoopRun['endReason']>,
  summary: string,
): LoopRun {
  run.status = 'ended'
  run.endReason = endReason
  run.updatedAt = Date.now()
  pushTimeline(run, 'system', summary)
  writeRun(run)

  if (run.openedFocus) {
    focusOff(run.platform, run.channelId, run.threadId)
  }
  return run
}

export function stopLoop(
  platform: string,
  channelId: string,
  threadId: string,
  reason: 'user_stop' | 'stop_verdict' | 'limit' | 'error' = 'user_stop',
): LoopRun | null {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return null
  return endLoopInternal(run, reason, `loop stopped (${reason})`)
}

/** Called when user turns Focus off/clear — cancel active Loop. */
export function cancelLoopForFocusOff(
  platform: string,
  channelId: string,
  threadId: string,
): LoopRun | null {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return null
  // Do not focusOff again — user already did / is doing it.
  run.status = 'ended'
  run.endReason = 'focus_off'
  run.updatedAt = Date.now()
  pushTimeline(run, 'system', 'loop cancelled because focus off/clear')
  // Avoid double focusOff: temporarily clear openedFocus side effect
  const opened = run.openedFocus
  run.openedFocus = false
  writeRun(run)
  run.openedFocus = opened
  return run
}

export function applyLoopVerdict(
  platform: string,
  channelId: string,
  threadId: string,
  verdict: LoopVerdict,
): { ok: true; run: LoopRun } | { ok: false; error: string } {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return { ok: false, error: 'no_active_loop' }

  run.lastVerdict = {
    decision: verdict.decision,
    summary: (verdict.summary || '').slice(0, 500),
    reasons: verdict.reasons?.map((r) => r.slice(0, 200)).slice(0, 8),
    nextHint: verdict.nextHint?.slice(0, 500),
  }
  run.updatedAt = Date.now()
  pushTimeline(run, 'observer', `${verdict.decision}: ${run.lastVerdict.summary}`)

  if (verdict.decision === 'stop') {
    endLoopInternal(run, 'stop_verdict', 'observer stop')
    return { ok: true, run }
  }

  if (run.round >= run.maxRounds) {
    endLoopInternal(run, 'limit', `maxRounds ${run.maxRounds}`)
    return { ok: true, run }
  }

  run.round += 1
  run.status = 'running'
  writeRun(run)
  return { ok: true, run }
}

export function buildLoopSnippet(
  platform: string,
  channelId: string,
  threadId: string,
): string {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return ''
  const lines: string[] = []
  lines.push(`[agim context — loop ACTIVE #${run.id.slice(0, 8)} round ${run.round}/${run.maxRounds}]`)
  lines.push(`Status: ${run.status}`)
  if (run.startNote) lines.push(`Start note: ${run.startNote}`)
  if (run.lastVerdict) {
    lines.push(`Last verdict: ${run.lastVerdict.decision} — ${run.lastVerdict.summary}`)
    if (run.lastVerdict.nextHint) lines.push(`Next hint: ${run.lastVerdict.nextHint}`)
  }
  lines.push(
    'You are the Loop executor. Work toward the Focus. When a checkpoint is appropriate, call mcp__agim__loop_verdict with continue|revise|stop (or wait for the observer). User can /loop stop.',
  )
  lines.push('')
  return lines.join('\n')
}

export function formatLoopStatus(run: LoopRun): string {
  const active = run.status !== 'ended'
  const lines = [
    `🔁 Loop \`${run.id.slice(0, 8)}\` — ${active ? run.status : `ended (${run.endReason ?? 'done'})`}`,
    `Round: ${run.round}/${run.maxRounds}`,
    `openedFocus: ${run.openedFocus ? 'yes（结束会 focus off）' : 'no（结束保留 focus）'}`,
    `Focus snapshot: ${run.focusSnapshot.slice(0, 200)}${run.focusSnapshot.length > 200 ? '…' : ''}`,
  ]
  if (run.startNote) lines.push(`Note: ${run.startNote}`)
  if (run.lastVerdict) {
    lines.push(`Last verdict: **${run.lastVerdict.decision}** — ${run.lastVerdict.summary}`)
  }
  if (run.timeline.length) {
    lines.push('', 'Recent:')
    for (const t of run.timeline.slice(-5)) {
      lines.push(`  - ${new Date(t.at).toISOString().slice(0, 16)} [${t.kind}] ${t.summary}`)
    }
  }
  return lines.join('\n')
}
