// web-thread-owners — persist WS threadId → tokenId ownership across restarts.
//
// In-memory Map alone lets a different token first-claim another operator's
// threadId after process restart. This module mirrors access-token's
// AGIM_HOME file layout with best-effort atomic writes.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'web-thread-owners' })

function ownersFile(): string {
  const home = process.env.AGIM_HOME?.trim() || AGIM_HOME
  return join(home, 'web-thread-owners.json')
}

interface OwnersFile {
  version: 1
  owners: Record<string, string>
}

function load(): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const raw = readFileSync(ownersFile(), 'utf-8')
    const parsed = JSON.parse(raw) as OwnersFile
    if (parsed?.version === 1 && parsed.owners && typeof parsed.owners === 'object') {
      for (const [threadId, tokenId] of Object.entries(parsed.owners)) {
        if (typeof threadId === 'string' && typeof tokenId === 'string' && threadId && tokenId) {
          map.set(threadId, tokenId)
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      log.warn({
        event: 'web.thread_owners.load_failed',
        err: err instanceof Error ? err.message : String(err),
      }, 'web-thread-owners.json unreadable; starting empty')
    }
  }
  return map
}

function persist(map: Map<string, string>): void {
  const file = ownersFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const body: OwnersFile = {
      version: 1,
      owners: Object.fromEntries(map.entries()),
    }
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    log.warn({
      event: 'web.thread_owners.persist_failed',
      err: err instanceof Error ? err.message : String(err),
    }, 'failed to persist web-thread-owners.json')
  }
}

/** Process-local cache + disk mirror. */
class ThreadOwnerStore {
  private map: Map<string, string> | null = null

  private ensure(): Map<string, string> {
    if (!this.map) this.map = load()
    return this.map
  }

  get(threadId: string): string | undefined {
    return this.ensure().get(threadId)
  }

  /** Claim or refresh ownership. Returns false if owned by someone else. */
  claim(threadId: string, tokenId: string): boolean {
    const map = this.ensure()
    const existing = map.get(threadId)
    if (existing !== undefined && existing !== tokenId) return false
    if (existing === tokenId) return true
    map.set(threadId, tokenId)
    persist(map)
    return true
  }

  set(threadId: string, tokenId: string): void {
    const map = this.ensure()
    map.set(threadId, tokenId)
    persist(map)
  }

  delete(threadId: string): void {
    const map = this.ensure()
    if (!map.delete(threadId)) return
    persist(map)
  }

  /** Move ownership key when a session rekeys to a new thread id. */
  rekey(oldId: string, newId: string): void {
    const map = this.ensure()
    const owner = map.get(oldId)
    if (owner === undefined) return
    map.delete(oldId)
    map.set(newId, owner)
    persist(map)
  }

  /** Test helper — drop cache so next access reloads from disk. */
  _resetForTests(): void {
    this.map = null
  }
}

export const webThreadOwners = new ThreadOwnerStore()
