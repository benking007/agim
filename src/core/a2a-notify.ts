// A2A notify — push short "system" messages back to the caller's IM thread
// at the start/complete/timeout/failed transitions of a callee invocation,
// plus optional heartbeats while the callee is mid-flight.
//
// Why: when Claude hands a long task off to codex, the IM channel goes
// silent for 5-20 minutes — the user can't tell whether the agent is stuck
// or thinking. These notifications keep the IM honest about what's
// happening downstream.
//
// Constraints (per the v1 spec in PROJECTS/im-viewer.md / the conversation
// on 2026-05-16):
//   - source: 'system'  — never routes through the viewer.
//   - depth ≤ IMHUB_A2A_NOTIFY_MAX_DEPTH (default 1) — deeper nested calls
//     stay silent to avoid spamming.
//   - mode tri-state: off / essential / verbose.
//     · essential (default): start + complete/timeout/failed only.
//     · verbose: also fires heartbeats every IMHUB_A2A_HEARTBEAT_MIN min.
//   - heartbeat trigger: file-change detection in _agim-output/, NOT a
//     fixed interval ping. If nothing changed since the last check, we
//     emit a "still thinking" note instead.

import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { logger as rootLogger } from './logger.js'
import { sink } from './message-sink.js'
import { savePaste } from './viewer-local.js'
import { buildPasteUrl } from './viewer-config.js'
import { getArtifactsDir } from './artifacts.js'
import type { RouteContext } from './router.js'

const log = rootLogger.child({ component: 'a2a-notify' })

export type NotifyMode = 'off' | 'essential' | 'verbose'

function readMode(): NotifyMode {
  const raw = (process.env.IMHUB_A2A_NOTIFY_MODE || 'essential').toLowerCase()
  if (raw === 'off' || raw === 'verbose') return raw
  return 'essential'
}

function readMaxDepth(): number {
  const raw = process.env.IMHUB_A2A_NOTIFY_MAX_DEPTH
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return 1
}

function readHeartbeatMinutes(): number {
  const raw = process.env.IMHUB_A2A_HEARTBEAT_MIN
  if (raw) {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 5
}

interface ImmutableCtx {
  platform: string
  channelId: string
  threadId: string
  callDepth: number
}

function shouldNotify(ctx: ImmutableCtx, mode: NotifyMode): boolean {
  if (mode === 'off') return false
  if (ctx.callDepth > readMaxDepth()) return false
  if (!ctx.platform || !ctx.threadId) return false
  return true
}

async function deliverNotice(ctx: ImmutableCtx, text: string): Promise<void> {
  try {
    await sink.deliver({
      platform: ctx.platform,
      channelId: ctx.channelId,
      threadId: ctx.threadId,
      payload: text,
      kind: 'text',
      priority: 'normal',
      source: 'system',
    })
  } catch (err) {
    log.warn({ event: 'a2a-notify.deliver_failed', err: String(err) })
  }
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}m` : `${m}m${r}s`
}

function extractCtx(routeCtx: RouteContext, calleeDepth: number): ImmutableCtx {
  return {
    platform: routeCtx.platform,
    channelId: routeCtx.channelId ?? '',
    threadId: routeCtx.threadId,
    callDepth: calleeDepth,
  }
}

// ─── Start ───────────────────────────────────────────────────────────────

export interface StartNoticeOpts {
  jobId: number
  callee: string
  inputCount: number
  expectOutputs?: string[]
  callerAgent?: string
}

export async function notifyA2AStart(
  routeCtx: RouteContext,
  calleeDepth: number,
  opts: StartNoticeOpts,
): Promise<void> {
  const mode = readMode()
  const ctx = extractCtx(routeCtx, calleeDepth)
  if (!shouldNotify(ctx, mode)) return

  const lines = [
    `🔀 转给 ${opts.callee}（#${opts.jobId} · depth ${calleeDepth}）`,
  ]
  if (opts.inputCount > 0) lines.push(`   📥 ${opts.inputCount} 个输入文件`)
  if (opts.expectOutputs && opts.expectOutputs.length > 0) {
    lines.push(`   📤 期望产出：${opts.expectOutputs.slice(0, 3).join('、')}${opts.expectOutputs.length > 3 ? '…' : ''}`)
  }
  await deliverNotice(ctx, lines.join('\n'))
}

// ─── Complete ────────────────────────────────────────────────────────────

export interface CompleteNoticeOpts {
  jobId: number
  callee: string
  durationMs: number
  outputs: Array<{ name: string; bytes: number }>
}

export async function notifyA2AComplete(
  routeCtx: RouteContext,
  calleeDepth: number,
  opts: CompleteNoticeOpts,
): Promise<void> {
  const mode = readMode()
  const ctx = extractCtx(routeCtx, calleeDepth)
  if (!shouldNotify(ctx, mode)) return

  const lines = [
    `✓ ${opts.callee} 完成（耗时 ${fmtDuration(opts.durationMs)}）`,
  ]
  if (opts.outputs.length > 0) {
    const names = opts.outputs.slice(0, 3).map((o) => o.name).join('、')
    lines.push(`   📎 ${names}${opts.outputs.length > 3 ? ` 等 ${opts.outputs.length} 个` : ''}`)

    // Best-effort viewer link to the first .md output for one-tap preview.
    const md = opts.outputs.find((o) => o.name.toLowerCase().endsWith('.md'))
    if (md) {
      const link = await snapshotToViewerLink(opts.jobId, md.name, `${opts.callee} #${opts.jobId} 输出 · ${md.name}`)
      if (link) lines.push(`   🔗 ${link}`)
    }
  }
  await deliverNotice(ctx, lines.join('\n'))
}

// ─── Timeout ─────────────────────────────────────────────────────────────

export async function notifyA2ATimeout(
  routeCtx: RouteContext,
  calleeDepth: number,
  opts: { jobId: number; callee: string; durationMs: number },
): Promise<void> {
  const mode = readMode()
  const ctx = extractCtx(routeCtx, calleeDepth)
  if (!shouldNotify(ctx, mode)) return

  await deliverNotice(ctx,
    `⌛ ${opts.callee} 超时（${fmtDuration(opts.durationMs)} 未返回，#${opts.jobId}）— 子进程已停`,
  )
}

// ─── Failed ──────────────────────────────────────────────────────────────

export async function notifyA2AFailed(
  routeCtx: RouteContext,
  calleeDepth: number,
  opts: { jobId: number; callee: string; durationMs: number; error: string },
): Promise<void> {
  const mode = readMode()
  const ctx = extractCtx(routeCtx, calleeDepth)
  if (!shouldNotify(ctx, mode)) return

  const errExcerpt = (opts.error || '').slice(0, 200)
  await deliverNotice(ctx,
    `❌ ${opts.callee} 失败（${fmtDuration(opts.durationMs)}，#${opts.jobId}）：${errExcerpt}`,
  )
}

// ─── Heartbeat (verbose mode only) ───────────────────────────────────────

interface HeartbeatState {
  jobId: number
  callee: string
  outputDir: string
  routeCtx: RouteContext
  calleeDepth: number
  startedAt: number
  lastSnapshot: Map<string, { bytes: number; mtimeMs: number }>
  /** Files whose link we've already pushed in a prior heartbeat — don't
   *  re-link the same .md file every N min. */
  linkedNames: Set<string>
  timer: NodeJS.Timeout
}

export function startHeartbeat(
  routeCtx: RouteContext,
  calleeDepth: number,
  jobId: number,
  callee: string,
): { stop: () => void } {
  const mode = readMode()
  const ctx = extractCtx(routeCtx, calleeDepth)
  if (mode !== 'verbose' || !shouldNotify(ctx, mode)) {
    return { stop: () => { /* no-op */ } }
  }

  const outputDir = getArtifactsDir(jobId).outputDir
  const intervalMs = readHeartbeatMinutes() * 60 * 1000
  const state: HeartbeatState = {
    jobId,
    callee,
    outputDir,
    routeCtx,
    calleeDepth,
    startedAt: Date.now(),
    lastSnapshot: new Map(),
    linkedNames: new Set(),
    // placeholder; reassigned below
    timer: setTimeout(() => undefined, 0),
  }

  const tick = async (): Promise<void> => {
    try {
      await heartbeatTick(state)
    } catch (err) {
      log.debug({ event: 'a2a-notify.heartbeat_tick_failed', err: String(err) })
    }
  }

  state.timer = setInterval(() => { void tick() }, intervalMs)

  return {
    stop: () => clearInterval(state.timer),
  }
}

async function heartbeatTick(state: HeartbeatState): Promise<void> {
  const elapsed = Date.now() - state.startedAt
  const current = await readOutputDir(state.outputDir)
  const newOrChanged: Array<{ name: string; bytes: number }> = []
  for (const [name, info] of current) {
    const prev = state.lastSnapshot.get(name)
    if (!prev || prev.bytes !== info.bytes || prev.mtimeMs !== info.mtimeMs) {
      newOrChanged.push({ name, bytes: info.bytes })
    }
  }
  state.lastSnapshot = current

  const ctx = extractCtx(state.routeCtx, state.calleeDepth)

  if (newOrChanged.length === 0) {
    // No file changes — emit a "still thinking" note. Shows up once per
    // heartbeat interval until either a file appears or the run terminates.
    await deliverNotice(ctx,
      `⏳ ${state.callee} 仍在跑（已 ${fmtDuration(elapsed)}，输出目录无变化，#${state.jobId}）`,
    )
    return
  }

  // Files changed — list them and link the most-likely-relevant .md.
  const head = newOrChanged.slice(0, 3).map((f) => `${f.name} (${f.bytes}B)`).join('、')
  const tailNote = newOrChanged.length > 3 ? ` 等 ${newOrChanged.length} 个` : ''
  const lines = [
    `⏳ ${state.callee} 仍在跑（已 ${fmtDuration(elapsed)}，#${state.jobId}）`,
    `   📝 新输出：${head}${tailNote}`,
  ]

  const md = newOrChanged.find((o) => o.name.toLowerCase().endsWith('.md') && !state.linkedNames.has(o.name))
  if (md) {
    const link = await snapshotToViewerLink(state.jobId, md.name, `${state.callee} #${state.jobId} 进度 · ${md.name}`)
    if (link) {
      state.linkedNames.add(md.name)
      lines.push(`   🔗 ${link}`)
    }
  }

  await deliverNotice(ctx, lines.join('\n'))
}

async function readOutputDir(dir: string): Promise<Map<string, { bytes: number; mtimeMs: number }>> {
  const out = new Map<string, { bytes: number; mtimeMs: number }>()
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    try {
      const st = await fs.stat(join(dir, name))
      if (st.isFile()) out.set(name, { bytes: st.size, mtimeMs: st.mtimeMs })
    } catch { /* ignore */ }
  }
  return out
}

/**
 * Snapshot a callee output file into the local viewer (so the operator gets
 * a stable /v/<uuid> link they can tap in IM without authenticating). Falls
 * back to the artifacts-download URL when the public base URL is missing or
 * paste-save fails. Returns null if neither is usable.
 */
async function snapshotToViewerLink(
  jobId: number,
  filename: string,
  title: string,
): Promise<string | null> {
  const outputDir = getArtifactsDir(jobId).outputDir
  try {
    const buf = await fs.readFile(join(outputDir, filename))
    const lower = filename.toLowerCase()
    const id = savePaste({
      content: buf.toString('utf8'),
      content_type: (lower.endsWith('.md') || lower.endsWith('.markdown')) ? 'markdown' : 'plain',
      title,
      source: `a2a:job-${jobId}:${filename}`,
      job_id: jobId,
    })
    if (id) {
      const url = buildPasteUrl(id)
      if (url) return url
    }
  } catch (err) {
    log.debug({ event: 'a2a-notify.snapshot_failed', filename, err: String(err) })
  }
  return null
}
