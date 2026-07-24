// loop-run — Phase C Loop session store (Focus-bound).
// SSOT: docs/architecture/loop-engineering.md
// Persistence: ~/.agim/loops/<threadKey>.json (fail-soft).
//
// R1: ALIGNING gate — objective + exit required before planning/dispatch.
// R2: LoopMission as persisted SSOT (partial while aligning; status shows both hard fields).
// R3: PLAN + DISPATCH — continue/revise requires ≥1 subagent call this round.
// R4: VERIFY + REFLECT — structured verification; unmet → nextDirection → replan; exit truncates.

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

/** R4 structured verification against mission.objective (+ acceptance). */
export interface LoopVerification {
  met: boolean
  summary: string
  gaps?: string[]
  nextDirection?: string
}

export interface LoopVerdict {
  decision: LoopDecision
  summary: string
  reasons?: string[]
  /** @deprecated prefer verification.nextDirection; still accepted as alias */
  nextHint?: string
  /** R4: required for continue/revise; optional on abandon stop */
  met?: boolean
  gaps?: string[]
  nextDirection?: string
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
  /** Stable store key: platform__channel__thread (also the json basename). */
  sessionKey: string
  platform: string
  channelId: string
  threadId: string
  focusSnapshot: string
  openedFocus: boolean
  status: LoopStatus
  endReason?:
    | 'stop_verdict'
    | 'user_stop'
    | 'limit'
    | 'wall_limit'
    | 'objective_met'
    | 'focus_off'
    | 'error'
  round: number
  /** Mirror of mission.exit.maxRounds when present; else provisional. */
  maxRounds: number
  startNote?: string
  /**
   * Mission SSOT. While ALIGNING may be partial (empty objective and/or
   * exit.description). After confirm both hard fields are non-empty.
   */
  mission: LoopMission | null
  /** Legacy mirrors of mission fields (kept in sync for older readers). */
  draftObjective?: string
  draftExitDescription?: string
  /** R3: subagent spawns accepted this round (call_agent / call_agents). */
  dispatchesThisRound: number
  /** R3: last decompose plan recorded from call_agents (or synthetic single). */
  lastPlan?: {
    at: number
    tasks: Array<{ id: string; brief: string; agentHint?: string }>
  }
  /** R4: last structured verification */
  lastVerification?: LoopVerification & { at: number }
  /** Independent evaluator (cheap) opinion on met=true stop claims */
  lastEvaluator?: {
    at: number
    agree: boolean
    reason: string
    skipped?: boolean
  }
  /** Cumulative usage for this Loop (C — Loop 用量) */
  usage: LoopUsage
  createdAt: number
  updatedAt: number
  lastVerdict?: LoopVerdict
  timeline: LoopTimelineEntry[]
}

export interface LoopUsage {
  /** Accepted call_agent(s) across all rounds */
  dispatchCount: number
  /** Independent evaluator invocations */
  evaluatorCount: number
  continueCount: number
  reviseCount: number
}

export function emptyLoopUsage(): LoopUsage {
  return { dispatchCount: 0, evaluatorCount: 0, continueCount: 0, reviseCount: 0 }
}

/** Readable mission view for status / snippet / aligning prompts. */
export interface LoopMissionView {
  objective: string
  exitDescription: string
  acceptance?: string
  maxRounds: number
  maxWallMs?: number
  confirmed: boolean
  partial: boolean
}

/** R5 UX buckets — user-facing “卡在哪”. */
export type LoopUxBucket = 'aligning' | 'dispatch' | 'verify' | 'ended'

export function getLoopUxBucket(run: LoopRun): LoopUxBucket {
  if (run.status === 'ended') return 'ended'
  if (run.status === 'aligning') return 'aligning'
  if (run.status === 'verifying' || run.status === 'reflecting') return 'verify'
  // After dispatch, waiting on structured verdict → 验收
  if ((run.dispatchesThisRound || 0) > 0) return 'verify'
  return 'dispatch'
}

export function loopUxBucketLabel(bucket: LoopUxBucket, lang: 'zh' | 'en' = 'zh'): string {
  if (lang === 'en') {
    switch (bucket) {
      case 'aligning': return 'Aligning'
      case 'dispatch': return 'Dispatch'
      case 'verify': return 'Verify'
      case 'ended': return 'Ended'
    }
  }
  switch (bucket) {
    case 'aligning': return '对焦'
    case 'dispatch': return '派工'
    case 'verify': return '验收'
    case 'ended': return '已结束'
  }
}

/** Compact DTO for Portal / REST (R5). */
export interface LoopStatusDto {
  id: string
  sessionKey: string
  status: LoopStatus
  bucket: LoopUxBucket
  bucketLabel: string
  active: boolean
  round: number
  maxRounds: number
  objective: string
  exitDescription: string
  acceptance?: string
  dispatchesThisRound: number
  endReason?: LoopRun['endReason']
  lastVerification?: LoopVerification & { at: number }
  lastEvaluator?: LoopRun['lastEvaluator']
  lastPlan?: LoopRun['lastPlan']
  usage: LoopUsage
  openedFocus: boolean
  createdAt: number
  updatedAt: number
  maxWallMs?: number
}

export function toLoopStatusDto(run: LoopRun, lang: 'zh' | 'en' = 'zh'): LoopStatusDto {
  const view = getMissionView(run)
  const bucket = getLoopUxBucket(run)
  const usage = run.usage || emptyLoopUsage()
  return {
    id: run.id,
    sessionKey: run.sessionKey || threadKey(run.platform, run.channelId, run.threadId),
    status: run.status,
    bucket,
    bucketLabel: loopUxBucketLabel(bucket, lang),
    active: run.status !== 'ended',
    round: run.round,
    maxRounds: view.maxRounds,
    objective: view.objective,
    exitDescription: view.exitDescription,
    acceptance: view.acceptance,
    dispatchesThisRound: run.dispatchesThisRound || 0,
    endReason: run.endReason,
    lastVerification: run.lastVerification,
    lastEvaluator: run.lastEvaluator,
    lastPlan: run.lastPlan,
    usage,
    openedFocus: run.openedFocus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    maxWallMs: view.maxWallMs,
  }
}

/** Markdown summary card when a Loop ends (R5). */
export function formatLoopEndedSummary(run: LoopRun): string {
  const view = getMissionView(run)
  const reason = run.endReason ?? 'done'
  const title =
    reason === 'objective_met' ? '✅ Loop 达标结束'
      : reason === 'wall_limit' ? '⏱ Loop 触达墙钟上限'
        : reason === 'limit' ? '⏹ Loop 触达轮次上限'
          : reason === 'focus_off' ? '⏹ Loop 因 Focus off 取消'
            : '🛑 Loop 已结束'
  const lines = [
    title,
    '',
    `**目标**：${view.objective || '（无）'}`,
    `**退出条件**：${view.exitDescription || '（无）'}`,
    `轮次：${run.round}/${view.maxRounds} · 原因：\`${reason}\``,
  ]
  const usage = run.usage || emptyLoopUsage()
  lines.push(
    `用量：派工 ${usage.dispatchCount} · 独立验收 ${usage.evaluatorCount}`
    + ` · continue ${usage.continueCount} · revise ${usage.reviseCount}`,
  )
  if (view.acceptance) lines.push(`**验收**：${view.acceptance}`)
  if (run.lastVerification) {
    lines.push(
      `**最终验收**：met=${run.lastVerification.met ? '是' : '否'} — ${run.lastVerification.summary}`,
    )
    if (run.lastVerification.gaps?.length) {
      lines.push(`缺口：${run.lastVerification.gaps.join('；')}`)
    }
  } else if (run.lastVerdict?.summary) {
    lines.push(`摘要：${run.lastVerdict.summary}`)
  }
  if (run.lastEvaluator && !run.lastEvaluator.skipped) {
    lines.push(
      `独立验收：${run.lastEvaluator.agree ? '同意' : '不同意'} — ${run.lastEvaluator.reason}`,
    )
  }
  return lines.join('\n')
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

function emptyMission(maxRounds: number): LoopMission {
  return {
    objective: '',
    exit: {
      description: '',
      maxRounds,
      onFocusOff: 'cancel',
    },
  }
}

function syncMissionMirrors(run: LoopRun): void {
  const maxRounds = run.maxRounds || defaultMaxRounds()
  if (!run.mission) {
    run.mission = emptyMission(maxRounds)
  }
  if (!run.mission.exit) {
    run.mission.exit = { description: '', maxRounds, onFocusOff: 'cancel' }
  }
  // Prefer mission as SSOT; backfill from drafts when mission fields empty
  if (!run.mission.objective.trim() && run.draftObjective?.trim()) {
    run.mission.objective = run.draftObjective.trim().slice(0, 500)
  }
  if (!run.mission.exit.description.trim() && run.draftExitDescription?.trim()) {
    run.mission.exit.description = run.draftExitDescription.trim().slice(0, 500)
  }
  // Mirror outward for legacy draft readers
  if (run.mission.objective) run.draftObjective = run.mission.objective
  if (run.mission.exit.description) run.draftExitDescription = run.mission.exit.description
  if (run.mission.exit.maxRounds > 0) run.maxRounds = run.mission.exit.maxRounds
  else run.mission.exit.maxRounds = maxRounds
  run.mission.exit.onFocusOff = 'cancel'
}

function normalizeRun(raw: LoopRun): LoopRun {
  if (!raw.sessionKey) {
    raw.sessionKey = threadKey(raw.platform, raw.channelId, raw.threadId)
  }
  if (raw.mission === undefined) {
    raw.mission = null
  }
  if (!Array.isArray(raw.timeline)) raw.timeline = []
  if (!raw.maxRounds || raw.maxRounds < 1) raw.maxRounds = defaultMaxRounds()
  if (typeof raw.dispatchesThisRound !== 'number' || raw.dispatchesThisRound < 0) {
    raw.dispatchesThisRound = 0
  }
  if (!raw.usage || typeof raw.usage !== 'object') {
    raw.usage = emptyLoopUsage()
  } else {
    raw.usage = {
      dispatchCount: Math.max(0, Number(raw.usage.dispatchCount) || 0),
      evaluatorCount: Math.max(0, Number(raw.usage.evaluatorCount) || 0),
      continueCount: Math.max(0, Number(raw.usage.continueCount) || 0),
      reviseCount: Math.max(0, Number(raw.usage.reviseCount) || 0),
    }
  }
  syncMissionMirrors(raw)
  return raw
}

/** Always-readable objective + exit (mission first, drafts as fallback). */
export function getMissionView(run: LoopRun): LoopMissionView {
  const maxRounds = run.mission?.exit?.maxRounds || run.maxRounds || defaultMaxRounds()
  const objective = (
    run.mission?.objective?.trim()
    || run.draftObjective?.trim()
    || ''
  )
  const exitDescription = (
    run.mission?.exit?.description?.trim()
    || run.draftExitDescription?.trim()
    || ''
  )
  const confirmed = run.status !== 'aligning' && !!objective && !!exitDescription
  return {
    objective,
    exitDescription,
    acceptance: run.mission?.acceptance?.trim() || undefined,
    maxRounds,
    maxWallMs: run.mission?.exit?.maxWallMs,
    confirmed,
    partial: !confirmed && (!!objective || !!exitDescription),
  }
}

/** Status / prompt lines for the two hard fields (+ optional acceptance). */
export function formatMissionFields(run: LoopRun, opts?: { draftLabel?: boolean }): string[] {
  const v = getMissionView(run)
  const draft = opts?.draftLabel && run.status === 'aligning'
  const objLabel = draft ? (v.objective ? '**目标**（草稿）' : '**目标**') : '**目标**'
  const exitLabel = draft ? (v.exitDescription ? '**退出条件**（草稿）' : '**退出条件**') : '**退出条件**'
  const lines = [
    `${objLabel}：${v.objective || '❌ 未设定'}`,
    `${exitLabel}：${v.exitDescription || '❌ 未设定'}`,
  ]
  if (v.acceptance) lines.push(`**验收**：${v.acceptance}`)
  if (v.maxWallMs) {
    const mins = Math.round(v.maxWallMs / 60_000)
    lines.push(`墙钟上限：${mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`}`)
  }
  return lines
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

/** True when mission.exit.maxWallMs elapsed since run.createdAt. */
export function isLoopWallExceeded(run: LoopRun, now = Date.now()): boolean {
  const wall = run.mission?.exit?.maxWallMs
  if (!wall || wall <= 0) return false
  return now - run.createdAt >= wall
}

function resolveVerification(verdict: LoopVerdict): LoopVerification | null {
  if (typeof verdict.met !== 'boolean') return null
  const nextDirection = (verdict.nextDirection || verdict.nextHint || '').trim() || undefined
  return {
    met: verdict.met,
    summary: (verdict.summary || '').slice(0, 500),
    ...(verdict.gaps && verdict.gaps.length > 0
      ? { gaps: verdict.gaps.map((g) => g.slice(0, 200)).slice(0, 8) }
      : {}),
    ...(nextDirection ? { nextDirection: nextDirection.slice(0, 500) } : {}),
  }
}

/** Parse exit NL for round / wall-clock caps (fail-soft). */
export function parseExitConstraints(exitDescription: string): {
  maxRounds?: number
  maxWallMs?: number
} {
  const text = exitDescription.trim()
  if (!text) return {}
  let maxRounds: number | undefined
  const roundsHit =
    text.match(/最多\s*(\d+)\s*轮/)
    || text.match(/重复\s*(\d+)\s*轮/)
    || text.match(/(\d+)\s*轮\s*结束/)
    || text.match(/(\d+)\s*rounds?/i)
  if (roundsHit) {
    const n = Number.parseInt(roundsHit[1]!, 10)
    if (Number.isFinite(n) && n > 0) maxRounds = Math.min(n, 100)
  }

  let maxWallMs: number | undefined
  const hoursHit = text.match(/超过\s*(\d+)\s*小时/) || text.match(/(\d+)\s*hours?\b/i)
  if (hoursHit) {
    const n = Number.parseInt(hoursHit[1]!, 10)
    if (Number.isFinite(n) && n > 0) maxWallMs = Math.min(n, 168) * 3_600_000
  } else {
    const minsHit = text.match(/超过\s*(\d+)\s*分钟/) || text.match(/(\d+)\s*min(?:ute)?s?\b/i)
    if (minsHit) {
      const n = Number.parseInt(minsHit[1]!, 10)
      if (Number.isFinite(n) && n > 0) maxWallMs = Math.min(n, 10_080) * 60_000
    }
  }
  return { maxRounds, maxWallMs }
}

function splitAcceptance(objectiveSide: string): { objective: string; acceptance?: string } {
  const t = objectiveSide.trim()
  const m =
    t.match(/^(.*?)[；;，,]\s*验收\s*[：:]\s*(.+)$/s)
    || t.match(/^(.*?)[；;，,]\s*acceptance\s*[：:]\s*(.+)$/is)
  if (!m) return { objective: t }
  return {
    objective: (m[1] ?? '').trim(),
    acceptance: (m[2] ?? '').trim().slice(0, 500) || undefined,
  }
}

/** Parse `/loop …` payload for objective + exit (NL-friendly). */
export function parseLoopStartText(text: string): {
  objective: string
  exitDescription: string
  acceptance?: string
  maxRounds?: number
  maxWallMs?: number
} {
  const raw = text.trim()
  if (!raw) return { objective: '', exitDescription: '' }

  let objective = raw
  let exitDescription = ''

  // Prefer natural phrases first, then short labels.
  // Examples:
  //   修好登录；退出条件为验收通过或最多5轮
  //   修好登录；验收：有回归；退出条件为 CI 绿
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

  const split = splitAcceptance(objective)
  objective = split.objective
  const constraints = parseExitConstraints(exitDescription)

  return {
    objective,
    exitDescription,
    acceptance: split.acceptance,
    maxRounds: constraints.maxRounds,
    maxWallMs: constraints.maxWallMs,
  }
}

function applyExitToMission(mission: LoopMission, exitDescription: string, parsed?: {
  maxRounds?: number
  maxWallMs?: number
}): void {
  const constraints = parsed ?? parseExitConstraints(exitDescription)
  mission.exit.description = exitDescription.slice(0, 500)
  if (constraints.maxRounds) mission.exit.maxRounds = constraints.maxRounds
  if (constraints.maxWallMs) mission.exit.maxWallMs = constraints.maxWallMs
  else delete mission.exit.maxWallMs
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

  const mission = emptyMission(maxRounds)
  mission.objective = objective
  if (parsed.acceptance) mission.acceptance = parsed.acceptance
  if (exitDescription) {
    applyExitToMission(mission, exitDescription, {
      maxRounds: parsed.maxRounds,
      maxWallMs: parsed.maxWallMs,
    })
  }

  const now = Date.now()
  const run: LoopRun = {
    id: randomUUID(),
    sessionKey: threadKey(input.platform, input.channelId, input.threadId),
    platform: input.platform,
    channelId: input.channelId,
    threadId: input.threadId,
    focusSnapshot: focusNow.title + (focusNow.body ? `\n${focusNow.body}` : ''),
    openedFocus,
    status: aligned ? 'planning' : 'aligning',
    round: aligned ? 1 : 0,
    maxRounds: mission.exit.maxRounds,
    startNote,
    mission,
    draftObjective: objective || undefined,
    draftExitDescription: exitDescription || undefined,
    dispatchesThisRound: 0,
    usage: emptyLoopUsage(),
    createdAt: now,
    updatedAt: now,
    timeline: [],
  }
  syncMissionMirrors(run)
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
  const split = splitAcceptance(objective.trim())
  const text = split.objective.slice(0, 500)
  if (!text) return { ok: false, error: 'empty' }
  if (!run.mission) run.mission = emptyMission(run.maxRounds || defaultMaxRounds())
  run.mission.objective = text
  if (split.acceptance) run.mission.acceptance = split.acceptance
  run.draftObjective = text
  syncMissionMirrors(run)
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
  if (!run.mission) run.mission = emptyMission(run.maxRounds || defaultMaxRounds())
  applyExitToMission(run.mission, text)
  run.draftExitDescription = text
  run.maxRounds = run.mission.exit.maxRounds
  syncMissionMirrors(run)
  run.updatedAt = Date.now()
  pushTimeline(run, 'user', `draft exit: ${text.slice(0, 120)}`)
  writeRun(run)
  return { ok: true, run }
}

export function setLoopAcceptance(
  platform: string,
  channelId: string,
  threadId: string,
  acceptance: string,
): { ok: true; run: LoopRun } | { ok: false; error: string } {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return { ok: false, error: 'no_active_loop' }
  // Allowed during aligning or after confirm (refine acceptance)
  if (run.status === 'ended') return { ok: false, error: 'ended' }
  const text = acceptance.trim().slice(0, 500)
  if (!text) return { ok: false, error: 'empty' }
  if (!run.mission) run.mission = emptyMission(run.maxRounds || defaultMaxRounds())
  run.mission.acceptance = text
  syncMissionMirrors(run)
  run.updatedAt = Date.now()
  pushTimeline(run, 'user', `acceptance: ${text.slice(0, 120)}`)
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

  syncMissionMirrors(run)
  const view = getMissionView(run)
  if (!view.objective || !view.exitDescription) {
    return { ok: false, error: 'incomplete' }
  }

  if (!run.mission) run.mission = emptyMission(view.maxRounds)
  run.mission.objective = view.objective
  applyExitToMission(run.mission, view.exitDescription)
  if (view.acceptance) run.mission.acceptance = view.acceptance
  run.maxRounds = run.mission.exit.maxRounds
  run.status = 'planning'
  run.round = 1
  run.dispatchesThisRound = 0
  syncMissionMirrors(run)
  run.updatedAt = Date.now()
  pushTimeline(run, 'system', 'mission confirmed → planning')
  writeRun(run)
  return { ok: true, run }
}

export type LoopPlanTask = { id: string; brief: string; agentHint?: string }

/**
 * Record that the active Loop accepted ≥1 subagent spawn this round.
 * Moves planning → dispatching. No-op when aligning / ended / no active loop.
 */
export function noteLoopDispatch(
  platform: string,
  channelId: string,
  threadId: string,
  input: {
    count?: number
    tasks?: LoopPlanTask[]
  } = {},
): LoopRun | null {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return null
  if (run.status === 'aligning' || run.status === 'ended') return run

  const n = Math.max(1, input.count ?? 1)
  run.dispatchesThisRound = (run.dispatchesThisRound || 0) + n
  if (!run.usage) run.usage = emptyLoopUsage()
  run.usage.dispatchCount += n
  if (input.tasks && input.tasks.length > 0) {
    run.lastPlan = {
      at: Date.now(),
      tasks: input.tasks.slice(0, 8).map((t, i) => ({
        id: (t.id || `t${i + 1}`).slice(0, 40),
        brief: (t.brief || '').slice(0, 200),
        ...(t.agentHint ? { agentHint: t.agentHint.slice(0, 80) } : {}),
      })),
    }
  }
  if (run.status === 'planning' || run.status === 'running' || run.status === 'observing'
      || run.status === 'reflecting') {
    run.status = 'dispatching'
  }
  run.updatedAt = Date.now()
  pushTimeline(run, 'system', `dispatch +${n} (round total ${run.dispatchesThisRound})`)
  writeRun(run)
  return run
}

/** Record independent evaluator result (does not count as R3 dispatch). */
export function noteLoopEvaluator(
  platform: string,
  channelId: string,
  threadId: string,
  result: { agree: boolean; reason: string; skipped?: boolean },
): LoopRun | null {
  const run = getActiveLoop(platform, channelId, threadId)
  if (!run) return null
  if (!run.usage) run.usage = emptyLoopUsage()
  if (!result.skipped) run.usage.evaluatorCount += 1
  run.lastEvaluator = {
    at: Date.now(),
    agree: result.agree,
    reason: (result.reason || '').slice(0, 500),
    ...(result.skipped ? { skipped: true } : {}),
  }
  run.updatedAt = Date.now()
  pushTimeline(
    run,
    'system',
    result.skipped
      ? `evaluator skipped: ${run.lastEvaluator.reason.slice(0, 120)}`
      : `evaluator ${result.agree ? 'agree' : 'disagree'}: ${run.lastEvaluator.reason.slice(0, 120)}`,
  )
  writeRun(run)
  return run
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

  // Exit truncation: wall clock (R4)
  if (isLoopWallExceeded(run)) {
    endLoopInternal(run, 'wall_limit', `maxWallMs ${run.mission?.exit.maxWallMs}`)
    return { ok: true, run }
  }

  const advancing = verdict.decision === 'continue' || verdict.decision === 'revise'

  // R3: continue/revise cannot complete a round without ≥1 subagent dispatch.
  // stop remains an exit hatch (user/observer may abandon without dispatch).
  if (advancing && (run.dispatchesThisRound || 0) < 1) {
    return { ok: false, error: 'no_dispatch' }
  }

  // R4: continue/revise require structured verification against objective.
  let verification: LoopVerification | null = null
  if (advancing) {
    verification = resolveVerification(verdict)
    if (!verification) {
      return { ok: false, error: 'need_verification' }
    }
    if (verification.met) {
      // Objective met → must stop, not continue another round.
      return { ok: false, error: 'met_use_stop' }
    }
    if (!verification.nextDirection) {
      return { ok: false, error: 'need_next_direction' }
    }
    run.status = 'verifying'
  } else if (typeof verdict.met === 'boolean') {
    // stop with optional verification
    verification = resolveVerification(verdict)
  }

  run.lastVerdict = {
    decision: verdict.decision,
    summary: (verdict.summary || '').slice(0, 500),
    reasons: verdict.reasons?.map((r) => r.slice(0, 200)).slice(0, 8),
    nextHint: (verdict.nextDirection || verdict.nextHint)?.slice(0, 500),
    ...(typeof verdict.met === 'boolean' ? { met: verdict.met } : {}),
    ...(verification?.gaps ? { gaps: verification.gaps } : {}),
    ...(verification?.nextDirection ? { nextDirection: verification.nextDirection } : {}),
  }
  if (verification) {
    run.lastVerification = { ...verification, at: Date.now() }
    run.status = verification.met ? 'verifying' : (advancing ? 'reflecting' : run.status)
  }
  run.updatedAt = Date.now()
  pushTimeline(
    run,
    'observer',
    verification
      ? `${verdict.decision} met=${verification.met}: ${verification.summary}`
      : `${verdict.decision}: ${run.lastVerdict.summary}`,
  )

  if (verdict.decision === 'stop') {
    if (verification?.met) {
      endLoopInternal(run, 'objective_met', 'objective met')
    } else {
      endLoopInternal(run, 'stop_verdict', 'observer stop')
    }
    return { ok: true, run }
  }

  // Exit truncation: max rounds (after a dispatched verify that did not meet)
  if (run.round >= run.maxRounds) {
    endLoopInternal(run, 'limit', `maxRounds ${run.maxRounds}`)
    return { ok: true, run }
  }

  // REFLECT → next PLANNING
  if (!run.usage) run.usage = emptyLoopUsage()
  if (verdict.decision === 'continue') run.usage.continueCount += 1
  if (verdict.decision === 'revise') run.usage.reviseCount += 1
  run.round += 1
  run.dispatchesThisRound = 0
  run.status = 'planning'
  if (verification?.nextDirection) {
    pushTimeline(run, 'system', `reflect → plan: ${verification.nextDirection.slice(0, 160)}`)
  }
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

  const view = getMissionView(run)
  if (run.status === 'aligning') {
    lines.push('Phase: ALIGNING (hard gate — do NOT call call_agent / call_agents / loop_verdict yet).')
    lines.push(`Objective: ${view.objective || '(missing)'}`)
    lines.push(`Exit: ${view.exitDescription || '(missing)'}`)
    if (view.acceptance) lines.push(`Acceptance: ${view.acceptance}`)
    lines.push(
      'Ask the user (mcp__agim__ask_user) to confirm BOTH objective and exit condition. '
      + 'Suggest they can also reply with `/loop objective …` / `/loop exit …` then `/loop confirm`.',
    )
    lines.push('')
    return lines.join('\n')
  }

  const phase =
    run.status === 'dispatching' ? 'DISPATCHING'
      : run.status === 'verifying' ? 'VERIFYING'
        : run.status === 'reflecting' ? 'REFLECTING'
          : 'PLANNING'
  lines.push(`Phase: ${phase} (R3/R4)`)
  lines.push(`Round: ${run.round}/${view.maxRounds}`)
  lines.push(`Objective: ${view.objective}`)
  lines.push(`Exit: ${view.exitDescription}`)
  if (view.acceptance) lines.push(`Acceptance: ${view.acceptance}`)
  if (view.maxWallMs) {
    const left = Math.max(0, run.createdAt + view.maxWallMs - Date.now())
    lines.push(`Wall budget left: ${Math.round(left / 60_000)}m`)
  }
  lines.push(`Dispatches this round: ${run.dispatchesThisRound || 0}`)
  if (run.lastPlan?.tasks?.length) {
    lines.push('Last plan:')
    for (const t of run.lastPlan.tasks.slice(0, 6)) {
      lines.push(`  - [${t.agentHint || '?'}] ${t.brief}`)
    }
  }
  if (run.startNote) lines.push(`Start note: ${run.startNote}`)
  if (run.lastVerification) {
    lines.push(
      `Last verification: met=${run.lastVerification.met} — ${run.lastVerification.summary}`,
    )
    if (run.lastVerification.gaps?.length) {
      lines.push(`Gaps: ${run.lastVerification.gaps.join('; ')}`)
    }
    if (run.lastVerification.nextDirection) {
      lines.push(`Next direction: ${run.lastVerification.nextDirection}`)
    }
  } else if (run.lastVerdict) {
    lines.push(`Last verdict: ${run.lastVerdict.decision} — ${run.lastVerdict.summary}`)
    if (run.lastVerdict.nextHint) lines.push(`Next hint: ${run.lastVerdict.nextHint}`)
  }
  if ((run.dispatchesThisRound || 0) < 1) {
    lines.push(
      'MUST decompose the objective into tasks and call mcp__agim__call_agents '
        + '(or call_agent) at least once this round before loop_verdict continue/revise. '
        + 'HARD GATE: do NOT web_fetch / web_search / exec / write the mission yourself '
        + 'until after the first call_agents — those tools are refused (AGIM_LOOP_DISPATCH_GATE). '
        + 'Write a short todo plan if needed, then immediately call_agents. '
        + 'Serial dispatch is fine. loop_verdict stop may end without dispatch. User can /loop stop.',
    )
  } else {
    lines.push(
      'VERIFY (R4): call loop_verdict with structured fields against Objective'
        + (view.acceptance ? '/Acceptance' : '')
        + ': met (boolean), summary, and if unmet: gaps[] + nextDirection. '
        + 'met=true → decision=stop (objective_met). '
        + 'met=false → decision=continue|revise (reflect → replan). '
        + 'Exit truncates on maxRounds / maxWallMs. User can /loop stop.',
    )
  }
  lines.push('')
  return lines.join('\n')
}

export function formatAligningPrompt(run: LoopRun): string {
  const view = getMissionView(run)
  const lines = [
    `🧭 Loop \`${run.id.slice(0, 8)}\` 进入 **对焦（ALIGNING）** — 确认前不会派子代理。`,
    '',
    ...formatMissionFields(run, { draftLabel: true }),
    '',
  ]
  if (!view.objective) {
    lines.push('请补充目标，例如：`/loop objective 完成登录超时修复并通过回归`')
  }
  if (!view.exitDescription) {
    lines.push('请补充退出条件，例如：`/loop exit 验收通过，或最多 5 轮`')
  }
  if (view.objective && view.exitDescription) {
    lines.push('两项草稿已齐，确认后开始：`/loop confirm`')
  } else {
    lines.push('也可一次写齐：`/loop 目标描述；退出条件为验收通过或最多5轮`（会新开 Loop，请先 `/loop stop` 当前对焦若需重来）')
  }
  lines.push('', '查看：`/loop status` · 放弃：`/loop stop`')
  return lines.join('\n')
}

/** Test-only: backdate createdAt for wall-clock exit coverage. */
export function _touchLoopCreatedAtForTests(
  platform: string,
  channelId: string,
  threadId: string,
  createdAt: number,
): void {
  const run = readRun(platform, channelId, threadId)
  if (!run) return
  run.createdAt = createdAt
  writeRun(run)
}

export function formatLoopStatus(run: LoopRun): string {
  const active = run.status !== 'ended'
  if (!active) {
    return formatLoopEndedSummary(run)
  }
  const view = getMissionView(run)
  const bucket = getLoopUxBucket(run)
  const lines = [
    `🔁 Loop \`${run.id.slice(0, 8)}\` — ${run.status}`,
    `当前阶段：**${loopUxBucketLabel(bucket)}**（${run.status}）`,
    `session: \`${run.sessionKey || threadKey(run.platform, run.channelId, run.threadId)}\``,
    `Round: ${run.round}/${view.maxRounds}`,
    `openedFocus: ${run.openedFocus ? 'yes（结束会 focus off）' : 'no（结束保留 focus）'}`,
    ...formatMissionFields(run, { draftLabel: run.status === 'aligning' }),
  ]
  if (run.status !== 'aligning') {
    lines.push(`本轮派工：${run.dispatchesThisRound || 0}${
      (run.dispatchesThisRound || 0) < 1 ? '（continue/revise 前至少 1 次 call_agent(s)）' : ''
    }`)
    const usage = run.usage || emptyLoopUsage()
    lines.push(
      `累计用量：派工 ${usage.dispatchCount} · 独立验收 ${usage.evaluatorCount}`
      + ` · continue ${usage.continueCount} · revise ${usage.reviseCount}`,
    )
    if (run.lastPlan?.tasks?.length) {
      lines.push('最近计划：')
      for (const t of run.lastPlan.tasks.slice(0, 5)) {
        lines.push(`  - ${t.agentHint ? `${t.agentHint}: ` : ''}${t.brief}`)
      }
    }
  }
  lines.push(
    `Focus snapshot: ${run.focusSnapshot.slice(0, 200)}${run.focusSnapshot.length > 200 ? '…' : ''}`,
  )
  if (run.startNote) lines.push(`Note: ${run.startNote}`)
  if (run.lastVerification) {
    lines.push(
      `最近验收：met=${run.lastVerification.met ? '✅' : '❌'} — ${run.lastVerification.summary}`,
    )
    if (run.lastVerification.gaps?.length) {
      lines.push(`缺口：${run.lastVerification.gaps.join('；')}`)
    }
    if (run.lastVerification.nextDirection) {
      lines.push(`下一方向：${run.lastVerification.nextDirection}`)
    }
  } else if (run.lastVerdict) {
    lines.push(`Last verdict: **${run.lastVerdict.decision}** — ${run.lastVerdict.summary}`)
  }
  if (view.maxWallMs) {
    const exceeded = isLoopWallExceeded(run)
    const left = Math.max(0, run.createdAt + view.maxWallMs - Date.now())
    lines.push(
      exceeded
        ? '墙钟：已触达上限'
        : `墙钟剩余：约 ${Math.round(left / 60_000)} 分钟`,
    )
  }
  if (run.timeline.length) {
    lines.push('', 'Recent:')
    for (const t of run.timeline.slice(-5)) {
      lines.push(`  - ${new Date(t.at).toISOString().slice(0, 16)} [${t.kind}] ${t.summary}`)
    }
  }
  return lines.join('\n')
}
