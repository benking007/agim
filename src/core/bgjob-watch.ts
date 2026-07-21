// bgjob-watch — poll shared ~/.agim/bgjobs for terminal transitions and
// push a short L1 status note back to the originating IM / Portal thread.
// Optional L2 (AGIM_BGJOB_AUTOSUMMARY=on) appends a log-tail digest.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agimBgjobsDir } from './bgjob-install.js'
import { logger as rootLogger } from './logger.js'
import { handlePushOp } from './push-rpc.js'
import type { RunContext } from './approval-bus.js'

const log = rootLogger.child({ component: 'bgjob-watch' })

const TERMINAL = new Set(['completed', 'failed', 'killed', 'stale'])
const DEFAULT_INTERVAL_MS = 5_000

interface JobOrigin {
  platform: string
  channelId: string
  threadId: string
  userId: string
}

interface JobMeta {
  id?: string
  name?: string
  status?: string
  exit_code?: number | null
  log?: string
  out_dir?: string
  origin?: JobOrigin | null
  notify_on_exit?: boolean
  notified_at?: string | null
  ended_at?: string | null
}

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
/** In-memory guard so we don't double-notify before meta write lands. */
const notifiedIds = new Set<string>()

function autosummaryEnabled(): boolean {
  const raw = (process.env.AGIM_BGJOB_AUTOSUMMARY || '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

function intervalMs(): number {
  const n = parseInt(process.env.AGIM_BGJOB_WATCH_MS || '', 10)
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS
}

async function readMeta(root: string, id: string): Promise<JobMeta | null> {
  if (id.includes('/') || id.includes('\\') || id === '..' || id === '.') return null
  try {
    const raw = await readFile(join(root, id, 'meta.json'), 'utf-8')
    return JSON.parse(raw) as JobMeta
  } catch {
    return null
  }
}

async function writeMeta(root: string, id: string, meta: JobMeta): Promise<void> {
  const path = join(root, id, 'meta.json')
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

async function listJobIds(root: string): Promise<string[]> {
  try {
    const raw = await readFile(join(root, 'index.json'), 'utf-8')
    const idx = JSON.parse(raw) as { jobs?: Array<{ id?: string }> }
    if (idx.jobs?.length) return idx.jobs.map((j) => j.id || '').filter(Boolean)
  } catch { /* fall through */ }
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function readLogTail(logPath: string | undefined, lines = 24): Promise<string> {
  if (!logPath) return ''
  try {
    const text = await readFile(logPath, 'utf-8')
    const all = text.split('\n')
    while (all.length && all[all.length - 1] === '') all.pop()
    return all.slice(-lines).join('\n').trim()
  } catch {
    return ''
  }
}

function buildL1Text(meta: JobMeta): string {
  const name = meta.name || meta.id || 'job'
  const code = meta.exit_code
  const ok = meta.status === 'completed' && code === 0
  if (ok) {
    return [
      `后台任务「${name}」已完成。`,
      meta.log ? `日志：${meta.log}` : null,
    ].filter(Boolean).join('\n')
  }
  const status = meta.status || 'failed'
  return [
    `后台任务「${name}」结束：${status}${code != null ? `（exit ${code}）` : ''}。`,
    meta.log ? `日志：${meta.log}` : null,
  ].filter(Boolean).join('\n')
}

function buildL2Text(meta: JobMeta, tail: string): string {
  const name = meta.name || meta.id || 'job'
  if (!tail) return `「${name}」无可用日志摘要。`
  const clipped = tail.length > 1200 ? `…\n${tail.slice(-1200)}` : tail
  return `「${name}」日志摘要：\n\`\`\`\n${clipped}\n\`\`\``
}

async function notifyJob(root: string, meta: JobMeta): Promise<void> {
  const id = meta.id
  if (!id || !meta.origin?.platform || !meta.origin.threadId) return
  if (meta.notify_on_exit === false) return
  if (meta.notified_at || notifiedIds.has(id)) return

  notifiedIds.add(id)
  const ctx: RunContext = {
    platform: meta.origin.platform,
    channelId: meta.origin.channelId || '',
    threadId: meta.origin.threadId,
    userId: meta.origin.userId || '',
  }

  const l1 = buildL1Text(meta)
  const r1 = await handlePushOp({ text: l1 }, ctx)
  if (!r1.ok) {
    notifiedIds.delete(id)
    log.warn({ event: 'bgjob.notify_failed', id, err: r1.error }, 'L1 bgjob notify failed')
    return
  }

  if (autosummaryEnabled()) {
    const tail = await readLogTail(meta.log)
    const l2 = buildL2Text(meta, tail)
    const r2 = await handlePushOp({ text: l2 }, ctx)
    if (!r2.ok) {
      log.warn({ event: 'bgjob.autosummary_failed', id, err: r2.error }, 'L2 bgjob digest failed')
    }
  }

  const next: JobMeta = {
    ...meta,
    notified_at: new Date().toISOString(),
  }
  try {
    await writeMeta(root, id, next)
  } catch (err) {
    log.warn({
      event: 'bgjob.notify_meta_write_failed',
      id,
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to persist notified_at')
  }

  log.info({
    event: 'bgjob.notified',
    id,
    status: meta.status,
    thread: `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`,
    autosummary: autosummaryEnabled(),
  }, 'bgjob exit notified origin thread')
}

/** One poll tick — exported for tests. */
export async function tickBgjobWatch(root = agimBgjobsDir()): Promise<number> {
  if (ticking) return 0
  ticking = true
  let notified = 0
  try {
    const ids = await listJobIds(root)
    for (const id of ids) {
      const meta = await readMeta(root, id)
      if (!meta?.id) continue
      const status = (meta.status || '').toLowerCase()
      if (!TERMINAL.has(status)) continue
      if (!meta.origin?.threadId) continue
      if (meta.notified_at || notifiedIds.has(meta.id)) continue
      const before = notifiedIds.size
      await notifyJob(root, meta)
      if (notifiedIds.size > before) notified++
    }
  } finally {
    ticking = false
  }
  return notified
}

export function startBgjobWatch(): void {
  if (timer) return
  const ms = intervalMs()
  log.info({ event: 'bgjob.watch_start', intervalMs: ms, root: agimBgjobsDir() }, 'bgjob exit watcher started')
  // Prime once, then interval.
  void tickBgjobWatch().catch((err) => {
    log.warn({ event: 'bgjob.watch_tick_failed', err: err instanceof Error ? err.message : String(err) })
  })
  timer = setInterval(() => {
    void tickBgjobWatch().catch((err) => {
      log.warn({ event: 'bgjob.watch_tick_failed', err: err instanceof Error ? err.message : String(err) })
    })
  }, ms)
  // Don't keep the process alive solely for the watcher in edge cases.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
}

export function stopBgjobWatch(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  notifiedIds.clear()
}

/** Test helper */
export function _resetBgjobWatchForTests(): void {
  stopBgjobWatch()
  notifiedIds.clear()
  ticking = false
}
