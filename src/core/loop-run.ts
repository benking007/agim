// loop-run — Phase C Loop session store (Focus-bound).
// SSOT: docs/architecture/loop-engineering.md
// Persistence: ~/.agim/loops/<threadKey>.json (fail-soft).
//
// R1: ALIGNING gate — objective + exit required before planning/dispatch.

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

/** L3 statuses; legacy 'running'|'observing' still read as active. */
export type LoopStatus =
  | 'aligning'
  | 'planning'
  | 'dispatching'
  | 'verifying'
  | 'reflecting'
  | 'running' // legacy / soft executor mode after confirm (pre-R3)
  | 'observing' // legacy
  | 'paused'
  | 'ended'

export type LoopDecision = 'continue' | 'revise' | 'stop'

export interface LoopVerdict {
  decision: LoopDecision
  summary: string
  reasons?: string[]
  nextHint?: string
}

export interface LoopMission {
  objective: string
  acceptance?: string
  exit: {
    description: string
    maxRounds: number
    maxWallMs?: number
    onFocusOff: 'cancel'
  }
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
  openedFocus: boolean
  status: LoopStatus
  endReason?: 'stop_verdict' | 'user_stop' | 'limit' | 'focus_off' | 'error'
  round: number
  /** Mirror of mission.exit.maxRounds when confirmed; else provisional. */
  maxRounds: number
  startNote?: string
  /** R1+ mission; null/partial while aligning */
  mission: LoopMission | null
  /** Draft fields before confirm */
  draftObjective?: string
  draftExitDescription?: string
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

function normalizeRun(raw: LoopRun): LoopRun {
  // Migrate pre-R1 rows
  if (raw.mission === undefined) {
    raw.mission = null
  }
  return raw
}

function readRun(platform: string, channelId: string, threadId: string): LoopRun | null {
  const p = pathFor(platform, channelId, threadId)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as LoopRun
    if (!raw || typeof raw !== 'object' || !raw.id) return null
    return normalizeRun(raw)
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

export function isLoopAligning(run: LoopRun): boolean {
  return run.status === 'aligning'
}

export function isLoopDispatchAllowed(run: LoopRun): boolean {
  if (run.status === 'ended' || run.status === 'aligning') return false
  return !!run.mission?.objective && !!run.mission?.exit?.description
}

/** Parse `/loop …` payload for objective + exit (NL-friendly). */
export function parseLoopStartText(text: string): {
  objective: string
  exitDescription: string
  maxRounds?: number
} {
  const raw = text.trim()
  if (!raw) return { objective: '', exitDescription: '' }

  let objective = raw
  let exitDescription = ''

  // Prefer natural phrases first, then short labels.
  // Examples:
  //   修好登录；退出条件为验收通过或最多5轮
  //   修好登录，退出条件是 CI 绿
  //   修好登录 退出条件为验收通过
  //   修好登录；退出：验收通过
  //   Fix auth; exit condition is PR green
  const m =
    raw.match(/^(.*?)(?:[；;，,。]?\s*)退出条件\s*(?:为|是|[：:])\s*(.+)$/s)
    || raw.match(/^(.*?)(?:[；;，,。]?\s*)exit\s*conditions?\s*(?:are|is|[：:])\s*(.+)$/is)
    || raw.match(/^(.*?)[；;]\s*退出\s*[：:]\s*(.+)$/s)
    || raw.match(/^(.*?)[；;]\s*exit\s*[：:]\s*(.+)$/is)
  if (m) {
    objective = (m[1] ?? '').trim()
    exitDescription = (m[2] ?? '').trim()
  }

  // Strip leading labels
  objective = objective.replace(/^(目标|objective)\s*[：:]\s*/i, '').trim()
  exitDescription = exitDescription
    .replace(/^(退出条件\s*(?:为|是)|退出|exit\s*conditions?\s*(?:are|is)|exit)\s*[：:]?\s*/i, '')
    .trim()

  let maxRounds: number | undefined
  const roundsHit = exitDescription.match(/最多\s*(\d+)\s*轮/) || exitDescription.match(/(\d+)\s*rounds?/i)
  if (roundsHit) {
    const n = Number.parseInt(roundsHit[1]!, 10)
    if (Number.isFinite(n) && n > 0) maxRounds = Math.min(n, 100)
  }

  return { objective, exitDescription, maxRounds }
}

function focusText(
  platform: string,
  channelId: string,
  threadId: string,
): string {
  const focus = getFocusOn(platform, channelId, threadId)
  if (!focus) return ''
  return (focus.title + (focus.body ? `\n${focus.body}` : '')).slice(0, 500)
}

/** Path A bare `/loop note` is a start note, not an objective override. */
function isExplicitObjectiveText(raw: string, parsed: { objective: string; exitDescription: string }): boolean {
  const t = raw.trim()
  if (!t) return false
  if (parsed.exitDescription) return true
  if (/^(目标|objective)\s*[：:]/i.test(t)) return true
  return false
}

export type StartLoopResult =
  | { ok: true; run: LoopRun; path: 'A' | 'B'; aligned: boolean }
  | { ok: false; error: string }

/**
 * Begin a Loop. Always creates a run; if objective or exit missing → aligning.
 * Path A: Focus already on. Path B: no Focus → require objective text to set Focus.
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

  const rawText = (input.text ?? '').trim()
  const parsed = parseLoopStartText(rawText)
  const focus = getFocusOn(input.platform, input.channelId, input.threadId)
  let openedFocus = false
  let path: 'A' | 'B'

  if (focus) {
    path = 'A'
  } else {
    path = 'B'
    const seed = parsed.objective || rawText
    if (!seed) return { ok: false, error: 'need_text' }
    const set = setFocus({
      platform: input.platform,
      channelId: input.channelId,
      threadId: input.threadId,
      userId: input.userId,
      title: seed.split('\n')[0]!.slice(0, 200),
      body: seed.includes('\n') ? seed.split('\n').slice(1).join('\n') : undefined,
    })
    if (!set) return { ok: false, error: 'focus_set_failed' }
    openedFocus = true
  }

  const focusNow = getFocusOn(input.platform, input.channelId, input.threadId)
  if (!focusNow) return { ok: false, error: 'focus_required' }

  const fromFocus = focusText(input.platform, input.channelId, input.threadId)
  let objective = ''
  let startNote: string | undefined
  if (path === 'A') {
    if (isExplicitObjectiveText(rawText, parsed)) {
      objective = (parsed.objective || fromFocus).slice(0, 500)
    } else {
      objective = fromFocus
      if (rawText) startNote = rawText.slice(0, 500)
    }
  } else {
    objective = (parsed.objective || rawText).slice(0, 500)
  }

  const exitDescription = parsed.exitDescription
  const maxRounds = parsed.maxRounds ?? defaultMaxRounds()
  const aligned = !!objective && !!exitDescription

  const now = Date.now()
  const run: LoopRun = {
    id: randomUUID(),
    platform: input.platform,
    channelId: input.channelId,
    threadId: input.threadId,
    focusSnapshot: focusNow.title + (focusNow.body ? `\n${focusNow.body}` : ''),
    openedFocus,
    status: aligned ? 'planning' : 'aligning',
    round: aligned ? 1 : 0,
    maxRounds,
    startNote,
    mission: aligned
      ? {
          objective,
          exit: {
            description: exitDescription,
            maxRounds,
            onFocusOff: 'cancel',
          },
        }
      : null,
    draftObjective: objective || undefined,
    draftExitDescription: exitDescription || undefined,
    createdAt: now,
    updatedAt: now,
    timeline: [],
  }
  pushTimeline(
    run,
    'user',
    aligned
      ? `loop confirmed (path ${path})`
      : `loop aligning (path ${path}); missing=${[
          !objective ? 'objective' : '',
          !exitDescription ? 'exit' : '',
        ].filter(Boolean).join('+')}`,
  )
  if (!writeRun(run)) return { ok: false, error: 'persist_failed' }
  return { ok: true, run, path, aligned }
}

export function setLoopObjective(
  platform: string,
  channelId: string,
  threadId: string,
  objective: string,
): { ok: true; run: LoopRun } | { ok: false; error: string } {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return { ok: false, error: 'no_active_loop' }
  if (run.status !== 'aligning') return { ok: false, error: 'not_aligning' }
  const text = objective.trim().slice(0, 500)
  if (!text) return { ok: false, error: 'empty' }
  run.draftObjective = text
  run.updatedAt = Date.now()
  pushTimeline(run, 'user', `draft objective: ${text.slice(0, 120)}`)
  writeRun(run)
  return { ok: true, run }
}

export function setLoopExit(
  platform: string,
  channelId: string,
  threadId: string,
  exitDescription: string,
): { ok: true; run: LoopRun } | { ok: false; error: string } {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return { ok: false, error: 'no_active_loop' }
  if (run.status !== 'aligning') return { ok: false, error: 'not_aligning' }
  const text = exitDescription.trim().slice(0, 500)
  if (!text) return { ok: false, error: 'empty' }
  run.draftExitDescription = text
  const parsed = parseLoopStartText(`x；退出：${text}`)
  if (parsed.maxRounds) run.maxRounds = parsed.maxRounds
  run.updatedAt = Date.now()
  pushTimeline(run, 'user', `draft exit: ${text.slice(0, 120)}`)
  writeRun(run)
  return { ok: true, run }
}

export function confirmLoopMission(
  platform: string,
  channelId: string,
  threadId: string,
): { ok: true; run: LoopRun } | { ok: false; error: string } {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return { ok: false, error: 'no_active_loop' }
  if (run.status !== 'aligning') return { ok: false, error: 'not_aligning' }

  const objective = (run.draftObjective || '').trim()
  const exitDescription = (run.draftExitDescription || '').trim()
  if (!objective || !exitDescription) {
    return { ok: false, error: 'incomplete' }
  }

  const maxRounds = run.maxRounds || defaultMaxRounds()
  run.mission = {
    objective,
    exit: {
      description: exitDescription,
      maxRounds,
      onFocusOff: 'cancel',
    },
  }
  run.maxRounds = maxRounds
  run.status = 'planning'
  run.round = 1
  run.updatedAt = Date.now()
  pushTimeline(run, 'system', 'mission confirmed → planning')
  writeRun(run)
  return { ok: true, run }
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

export function cancelLoopForFocusOff(
  platform: string,
  channelId: string,
  threadId: string,
): LoopRun | null {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return null
  run.status = 'ended'
  run.endReason = 'focus_off'
  run.updatedAt = Date.now()
  pushTimeline(run, 'system', 'loop cancelled because focus off/clear')
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
  if (run.status === 'aligning') {
    return { ok: false, error: 'aligning' }
  }
  if (!isLoopDispatchAllowed(run) && run.status !== 'running' && run.status !== 'observing'
      && run.status !== 'planning' && run.status !== 'dispatching'
      && run.status !== 'verifying' && run.status !== 'reflecting') {
    return { ok: false, error: 'not_ready' }
  }

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
  lines.push(`[agim context — loop ACTIVE #${run.id.slice(0, 8)} status=${run.status}]`)

  if (run.status === 'aligning') {
    lines.push('Phase: ALIGNING (hard gate — do NOT call call_agent / call_agents / loop_verdict yet).')
    lines.push(`Draft objective: ${run.draftObjective || '(missing)'}`)
    lines.push(`Draft exit: ${run.draftExitDescription || '(missing)'}`)
    lines.push(
      'Ask the user (mcp__agim__ask_user) to confirm BOTH objective and exit condition. '
      + 'Suggest they can also reply with `/loop objective …` / `/loop exit …` then `/loop confirm`.',
    )
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`Round: ${run.round}/${run.maxRounds}`)
  if (run.mission) {
    lines.push(`Objective: ${run.mission.objective}`)
    lines.push(`Exit: ${run.mission.exit.description}`)
  }
  if (run.startNote) lines.push(`Start note: ${run.startNote}`)
  if (run.lastVerdict) {
    lines.push(`Last verdict: ${run.lastVerdict.decision} — ${run.lastVerdict.summary}`)
    if (run.lastVerdict.nextHint) lines.push(`Next hint: ${run.lastVerdict.nextHint}`)
  }
  lines.push(
    'Loop mission is confirmed. Prefer decomposing and mcp__agim__call_agents when useful. '
      + 'Verify against Objective/Exit. User can /loop stop.',
  )
  lines.push('')
  return lines.join('\n')
}

export function formatAligningPrompt(run: LoopRun): string {
  const obj = run.draftObjective?.trim() || ''
  const exit = run.draftExitDescription?.trim() || ''
  const lines = [
    `🧭 Loop \`${run.id.slice(0, 8)}\` 进入 **对焦（ALIGNING）** — 确认前不会派子代理。`,
    '',
    `**目标**：${obj || '❌ 未设定'}`,
    `**退出条件**：${exit || '❌ 未设定'}`,
    '',
  ]
  if (!obj) {
    lines.push('请补充目标，例如：`/loop objective 完成登录超时修复并通过回归`')
  }
  if (!exit) {
    lines.push('请补充退出条件，例如：`/loop exit 验收通过，或最多 5 轮`')
  }
  if (obj && exit) {
    lines.push('两项草稿已齐，确认后开始：`/loop confirm`')
  } else {
    lines.push('也可一次写齐：`/loop 目标描述；退出条件为验收通过或最多5轮`（会新开 Loop，请先 `/loop stop` 当前对焦若需重来）')
  }
  lines.push('', '查看：`/loop status` · 放弃：`/loop stop`')
  return lines.join('\n')
}

export function formatLoopStatus(run: LoopRun): string {
  const active = run.status !== 'ended'
  const lines = [
    `🔁 Loop \`${run.id.slice(0, 8)}\` — ${active ? run.status : `ended (${run.endReason ?? 'done'})`}`,
    `Round: ${run.round}/${run.maxRounds}`,
    `openedFocus: ${run.openedFocus ? 'yes（结束会 focus off）' : 'no（结束保留 focus）'}`,
  ]
  if (run.mission) {
    lines.push(`**目标**：${run.mission.objective}`)
    lines.push(`**退出**：${run.mission.exit.description}`)
  } else {
    lines.push(`草稿目标：${run.draftObjective || '（无）'}`)
    lines.push(`草稿退出：${run.draftExitDescription || '（无）'}`)
  }
  lines.push(
    `Focus snapshot: ${run.focusSnapshot.slice(0, 200)}${run.focusSnapshot.length > 200 ? '…' : ''}`,
  )
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
