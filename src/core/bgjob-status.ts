// bgjob-status — port of bin/bgjob `_refresh_status` for Node readers/watchers.
//
// The Python wrapper only writes `exit_code` on process exit; `meta.status`
// stays `running` until a CLI `status`/`list` call refreshes it. Agim's
// bgjob-watch (exit notify) and bgjob-reader (Tasks / Portal) never invoke
// that CLI path, so they must perform the same refresh themselves.

import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface RefreshableJobMeta {
  id?: string
  status?: string
  pid?: number | null
  pid_starttime?: number | null
  pgid?: number | null
  exit_code?: number | null
  ended_at?: string | null
}

function nowIso(): string {
  // Match Python `_now()` shape closely enough for humans / ISO consumers.
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM → process exists but not ours
    return code === 'EPERM'
  }
}

function getProcStarttime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rparen = stat.lastIndexOf(')')
    if (rparen < 0) return null
    const tail = stat.slice(rparen + 2).split(/\s+/)
    // starttime is field 22 → index 19 after `comm`
    if (tail.length < 20) return null
    const n = parseInt(tail[19]!, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function getProcPgid(pid: number): number | null {
  // Prefer /proc (portable across Node builds; process.getpgid is not
  // universally typed). Field 5 (pgrp) sits at index 2 after `comm`.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rparen = stat.lastIndexOf(')')
    if (rparen < 0) return null
    const tail = stat.slice(rparen + 2).split(/\s+/)
    if (tail.length < 3) return null
    const n = parseInt(tail[2]!, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function getProcState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rparen = stat.lastIndexOf(')')
    if (rparen < 0) return null
    const tail = stat.slice(rparen + 2).split(/\s+/)
    return tail[0] || null
  } catch {
    return null
  }
}

/** True only if pid exists, starttime matches, and pgid matches. */
export function assertJobPidAlive(meta: RefreshableJobMeta): boolean {
  const pid = typeof meta.pid === 'number' ? meta.pid : 0
  if (!pid || !pidAlive(pid)) return false
  if (meta.pid_starttime != null) {
    const cur = getProcStarttime(pid)
    if (cur === null || cur !== meta.pid_starttime) return false
  }
  if (meta.pgid != null) {
    const cur = getProcPgid(pid)
    if (cur === null || cur !== meta.pgid) return false
  }
  return true
}

async function writeMeta(root: string, id: string, meta: RefreshableJobMeta): Promise<void> {
  const path = join(root, id, 'meta.json')
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8')
  await rename(tmp, path)
}

function readExitCode(root: string, id: string): number {
  const exitFile = join(root, id, 'exit_code')
  if (!existsSync(exitFile)) return -1
  try {
    const raw = readFileSync(exitFile, 'utf8').trim()
    const code = parseInt(raw || '-1', 10)
    return Number.isFinite(code) ? code : -1
  } catch {
    return -1
  }
}

/**
 * If job is marked running/paused but the process is gone (or stolen),
 * derive outcome from the `exit_code` file and persist meta. Returns the
 * (possibly updated) meta object.
 */
export async function refreshJobStatus<T extends RefreshableJobMeta>(
  root: string,
  meta: T,
): Promise<T> {
  const id = meta.id
  if (!id) return meta
  const s = (meta.status || '').toLowerCase()
  if (s !== 'running' && s !== 'paused') return meta

  if (assertJobPidAlive(meta)) {
    if (s === 'running') {
      const pid = typeof meta.pid === 'number' ? meta.pid : 0
      const state = pid ? getProcState(pid) : null
      if (state === 'T') {
        meta.status = 'paused'
        try {
          await writeMeta(root, id, meta)
        } catch { /* best-effort */ }
      }
    }
    return meta
  }

  const code = readExitCode(root, id)
  meta.status = code === 0 ? 'completed' : 'failed'
  meta.exit_code = code
  if (!meta.ended_at) meta.ended_at = nowIso()
  try {
    await writeMeta(root, id, meta)
  } catch { /* best-effort — caller still sees in-memory update */ }
  return meta
}

/** Read meta.json then refresh status. */
export async function readAndRefreshMeta(
  root: string,
  id: string,
): Promise<RefreshableJobMeta | null> {
  if (id.includes('/') || id.includes('\\') || id === '..' || id === '.') return null
  try {
    const raw = await readFile(join(root, id, 'meta.json'), 'utf-8')
    const meta = JSON.parse(raw) as RefreshableJobMeta
    if (!meta.id) meta.id = id
    return await refreshJobStatus(root, meta)
  } catch {
    return null
  }
}
