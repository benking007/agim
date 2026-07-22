// Message thumbs up/down — durable sidecar next to session JSONL.
//
// On-disk: ~/.agim/sessions/<safe-key>.feedback.json
// Not written into ChatMessage bodies (keeps durable transcript clean).
// Votes restore in the SPA; only downvotes arm an ephemeral next-turn hint
// (see message-feedback-hints.ts). Compaction does not read this file.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'message-feedback' })

const SESSIONS_DIR = join(AGIM_HOME, 'sessions')

export type MessageVote = 'up' | 'down'

export interface FeedbackEntry {
  messageIndex: number
  messageId?: string
  vote: MessageVote
  updatedAt: string
}

interface FeedbackFile {
  version: 1
  entries: FeedbackEntry[]
}

function sanitizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) => {
    return createHash('sha256').update(c).digest('hex').slice(0, 8)
  })
}

function threadKey(platform: string, channelId: string, threadId: string): string {
  return `${platform}:${channelId}:${threadId}`
}

function feedbackPath(platform: string, channelId: string, threadId: string): string {
  return join(SESSIONS_DIR, `${sanitizeKey(threadKey(platform, channelId, threadId))}.feedback.json`)
}

async function readFileSafe(path: string): Promise<FeedbackFile> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as FeedbackFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] }
    }
    return {
      version: 1,
      entries: parsed.entries.filter((e): e is FeedbackEntry => (
        !!e
        && typeof e.messageIndex === 'number'
        && Number.isInteger(e.messageIndex)
        && e.messageIndex >= 0
        && (e.vote === 'up' || e.vote === 'down')
      )),
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      log.warn({ err: String(err), path }, 'failed to read feedback sidecar')
    }
    return { version: 1, entries: [] }
  }
}

async function writeFileAtomic(path: string, data: FeedbackFile): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const body = `${JSON.stringify(data, null, 2)}\n`
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, path)
}

/** Mint a durable chat-message id (also used by SessionManager.addMessage). */
export function mintChatMessageId(): string {
  return `msg-${randomBytes(6).toString('hex')}`
}

export async function listMessageFeedback(
  platform: string,
  channelId: string,
  threadId: string,
): Promise<FeedbackEntry[]> {
  const file = await readFileSafe(feedbackPath(platform, channelId, threadId))
  return file.entries
}

/** Resolve vote for a history message (prefer id, fall back to index). */
export function resolveFeedbackVote(
  entries: readonly FeedbackEntry[],
  opts: { messageId?: string; messageIndex: number },
): MessageVote | undefined {
  if (opts.messageId) {
    const byId = entries.find((e) => e.messageId === opts.messageId)
    if (byId) return byId.vote
  }
  return entries.find((e) => e.messageIndex === opts.messageIndex)?.vote
}

export async function upsertMessageFeedback(opts: {
  platform: string
  channelId: string
  threadId: string
  messageIndex: number
  messageId?: string
  vote: MessageVote | null
}): Promise<{ vote: MessageVote | null }> {
  const path = feedbackPath(opts.platform, opts.channelId, opts.threadId)
  const file = await readFileSafe(path)
  const next = file.entries.filter((e) => {
    if (opts.messageId && e.messageId === opts.messageId) return false
    if (e.messageIndex === opts.messageIndex) return false
    return true
  })

  if (opts.vote == null) {
    if (next.length === 0) {
      try { await unlink(path) } catch { /* missing ok */ }
    } else {
      await writeFileAtomic(path, { version: 1, entries: next })
    }
    return { vote: null }
  }

  next.push({
    messageIndex: opts.messageIndex,
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    vote: opts.vote,
    updatedAt: new Date().toISOString(),
  })
  await writeFileAtomic(path, { version: 1, entries: next })
  return { vote: opts.vote }
}

export async function clearThreadFeedback(
  platform: string,
  channelId: string,
  threadId: string,
): Promise<void> {
  const path = feedbackPath(platform, channelId, threadId)
  try {
    await unlink(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      log.warn({ err: String(err), path }, 'failed to clear feedback sidecar')
    }
  }
}
