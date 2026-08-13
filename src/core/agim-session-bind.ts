// threadId ↔ native (pi JSONL) session id association.
//
// Agim keeps two logs on purpose:
//   ~/.agim/sessions/*.log          — UI transcript, keyed by threadId
//   ~/.agim/agim-sessions/*.jsonl   — model-visible pi session, keyed by session.id
// Do not merge them. This index is a join table so operators can map a
// Portal thread to the Agim Agent JSONL (and A2A `a2a-<jobId>` children
// back to the parent thread) without concatenating the files.

import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'agim-session-bind' })

export function nativeSessionIndexPath(): string {
  return join(AGIM_HOME, 'agim-session-index.jsonl')
}

export interface NativeSessionBind {
  nativeSessionId: string
  threadId?: string
  platform?: string
  channelId?: string
  parentJobId?: number
  at?: number
}

/** Record one native JSONL session ↔ thread binding (append-only JSONL). */
export function bindNativeSession(input: NativeSessionBind): void {
  const nativeSessionId = (input.nativeSessionId || '').trim()
  if (!nativeSessionId) return
  const rec: NativeSessionBind = {
    nativeSessionId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(typeof input.parentJobId === 'number' ? { parentJobId: input.parentJobId } : {}),
    at: input.at ?? Date.now(),
  }
  log.info({
    event: 'agim-agent.session.bind',
    ...rec,
  }, `native session ${nativeSessionId} ↔ thread ${rec.threadId || '(none)'}`)
  try {
    const path = nativeSessionIndexPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const line = `${JSON.stringify(rec)}\n`
    if (existsSync(path)) appendFileSync(path, line, 'utf8')
    else writeFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(path, 0o600) } catch { /* best-effort */ }
  } catch (err) {
    log.debug({
      event: 'agim-agent.session.bind_write_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'native session index write failed (non-fatal)')
  }
}
