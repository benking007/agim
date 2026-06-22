// agim TUI session persistence — saves chat transcript so the user
// can pick up where they left off with `agim tui --resume <id>`.
//
// Storage: <AGIM_HOME>/tui-sessions/<id>.json
// File shape: { id, agent, agentSessions?, cwd, createdAt, updatedAt, messages: [...] }
//
// We save on:
//   - graceful exit (TuiApp's onExit handler)
//   - end of each agent turn (so SIGKILL still preserves the last
//     full exchange)
//
// Failures are warned to the logger but never propagate — losing a
// session is a quality-of-life regression, not data corruption.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { AGIM_HOME } from '../../core/agim-paths.js'
import { logger as rootLogger } from '../../core/logger.js'

const log = rootLogger.child({ component: 'tui.sessions' })

export const TUI_SESSIONS_DIR = join(AGIM_HOME, 'tui-sessions')

export interface StoredMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  elapsedMs?: number
  agentName?: string
}

export interface StoredSession {
  id: string
  agent: string | undefined
  /** Agent-native resumable session ids keyed by agent name. */
  agentSessions?: Record<string, string>
  cwd: string
  createdAt: string
  updatedAt: string
  messages: StoredMessage[]
}

/** Pretty timestamp prefix + 6 hex bytes — sortable by mtime AND id. */
export function generateSessionId(): string {
  const d = new Date()
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rnd = randomBytes(3).toString('hex')
  return `tui-${stamp}-${rnd}`
}

function ensureDir(): void {
  try { mkdirSync(TUI_SESSIONS_DIR, { recursive: true }) } catch (err) {
    log.warn({ event: 'tui.sessions.mkdir_failed', err: err instanceof Error ? err.message : String(err) })
  }
}

export function saveSession(s: StoredSession): void {
  // Empty + system-only sessions aren't worth a file — saves clutter
  // when the user just launched and exited without chatting.
  const meaningful = s.messages.filter((m) => m.role !== 'system').length > 0
  if (!meaningful) return
  ensureDir()
  const file = join(TUI_SESSIONS_DIR, `${s.id}.json`)
  try {
    writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 })
  } catch (err) {
    log.warn({ event: 'tui.sessions.save_failed', file, err: err instanceof Error ? err.message : String(err) })
  }
}

export function loadSession(id: string): StoredSession | null {
  const file = join(TUI_SESSIONS_DIR, `${id}.json`)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredSession>
    const next: StoredSession = {
      id: parsed.id || id,
      agent: parsed.agent,
      agentSessions: parsed.agentSessions && typeof parsed.agentSessions === 'object' ? parsed.agentSessions : undefined,
      cwd: parsed.cwd || '',
      createdAt: parsed.createdAt || new Date(0).toISOString(),
      updatedAt: parsed.updatedAt || new Date(0).toISOString(),
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    }
    return next
  } catch (err) {
    log.warn({ event: 'tui.sessions.load_failed', file, err: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export interface SessionMeta {
  id: string
  agent: string | undefined
  cwd: string
  updatedAt: string
  messages: number
  bytes: number
}

/** Latest first. Cheap: only reads filenames + stat; doesn't open JSON.
 *  For richer info we open per-file (used by --list-sessions full path). */
export function listSessions(limit = 20, full = false): SessionMeta[] {
  if (!existsSync(TUI_SESSIONS_DIR)) return []
  let names: string[] = []
  try {
    names = readdirSync(TUI_SESSIONS_DIR).filter((n) => n.endsWith('.json'))
  } catch (err) {
    log.warn({ event: 'tui.sessions.list_failed', err: err instanceof Error ? err.message : String(err) })
    return []
  }
  const out: SessionMeta[] = []
  for (const n of names) {
    const file = join(TUI_SESSIONS_DIR, n)
    let st: import('node:fs').Stats
    try { st = statSync(file) } catch { continue }
    const id = n.replace(/\.json$/, '')
    let agent: string | undefined
    let cwd = ''
    let updatedAt = st.mtime.toISOString()
    let msgCount = 0
    if (full) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as StoredSession
        agent = parsed.agent
        cwd = parsed.cwd
        updatedAt = parsed.updatedAt || updatedAt
        msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0
      } catch { /* ignore */ }
    }
    out.push({ id, agent, cwd, updatedAt, messages: msgCount, bytes: st.size })
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return out.slice(0, limit)
}
