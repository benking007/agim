/**
 * Account-level web session list: pull from / push to GET|POST /api/me/sessions.
 *
 * Uses `client` so Mac-shell / remote browsers send Bearer as well as the
 * session cookie. Failures stay silent — the local rail remains usable.
 */

import { client } from '@/lib/api/client'
import {
  isWebThreadId,
  replaceIndexFromServer,
  type WebSessionEntry,
} from '@/lib/web-sessions'

export interface RemoteWebSession {
  id: string
  title?: string
  updatedAt: number
  agent?: string
  archivedAt?: number
}

export interface PushSessionPatch {
  threadId: string
  title?: string
  archivedAt?: number | null
  agent?: string
}

export async function pullAccountSessions(activeId?: string): Promise<boolean> {
  try {
    const body = await client.get<{ sessions?: RemoteWebSession[] }>('/api/me/sessions')
    const rows: WebSessionEntry[] = (body.sessions ?? [])
      .filter((s) => typeof s.id === 'string' && isWebThreadId(s.id))
      .map((s) => ({
        id: s.id,
        updatedAt: typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
        title: s.title,
        agent: s.agent,
        ...(typeof s.archivedAt === 'number' ? { archivedAt: s.archivedAt } : {}),
      }))
    replaceIndexFromServer(rows, activeId)
    return true
  } catch {
    return false
  }
}

export async function pushAccountSession(patch: PushSessionPatch): Promise<boolean> {
  const threadId = patch.threadId.trim()
  if (!isWebThreadId(threadId)) return false
  try {
    await client.post('/api/me/sessions', {
      body: {
        threadId,
        ...(patch.title ? { title: patch.title } : {}),
        ...(patch.archivedAt === undefined ? {} : { archivedAt: patch.archivedAt }),
        ...(patch.agent ? { agent: patch.agent } : {}),
      },
    })
    return true
  } catch {
    return false
  }
}
