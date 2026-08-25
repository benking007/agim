// member-scope — resolve a web request into an admin vs member visibility
// window. Admins still see instance-wide ops surfaces (jobs board, reminders).
// Portal automations use requestOwnerId() so even an admin only sees their
// own scheduled tasks. Members see rows tied to their account id or to web
// threads they own. Ownerless / foreign rows stay hidden.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestActor, getRequestUserId, isRequestAdmin } from './auth.js'
import { sendError } from './http-utils.js'

const MAX_THREAD_KEYS = 400

export type MemberScope =
  | { kind: 'admin' }
  | { kind: 'user'; userId: string; threadIds: string[]; threadKeys: string[] }
  | { kind: 'none' }

export function webThreadKey(threadId: string): string {
  return `web:web:${threadId}`
}

export async function resolveMemberScope(req: IncomingMessage): Promise<MemberScope> {
  if (isRequestAdmin(req)) return { kind: 'admin' }
  const userId = getRequestUserId(req)
  if (!userId) return { kind: 'none' }
  const { sessionManager } = await import('../core/session.js')
  const sessions = await sessionManager.listUserWebSessions(userId)
  const threadIds = sessions.map((s) => s.id).slice(0, MAX_THREAD_KEYS)
  return {
    kind: 'user',
    userId,
    threadIds,
    threadKeys: threadIds.map(webThreadKey),
  }
}

export function sendForbidden(res: ServerResponse, message = 'not allowed'): void {
  sendError(res, 403, 'FORBIDDEN', { message })
}

/** List/read APIs: empty result rather than 403 when the actor has no account. */
export function emptyMemberScope(scope: MemberScope): scope is { kind: 'none' } {
  return scope.kind === 'none'
}

/**
 * Owner key for Portal-owned rows (scheduled tasks, "mine" job lists).
 * Logged-in accounts — including admins — are scoped to their `usr_*` id
 * so one person's automations never appear in another person's list.
 * Loopback / auth-off without a user id fall back to the stable actor
 * string (`web:loopback` / `web:auth-off`).
 */
export function requestOwnerId(req: IncomingMessage): string | undefined {
  const userId = getRequestUserId(req)
  if (userId) return userId
  if (!isRequestAdmin(req)) return undefined
  const actor = getRequestActor(req)
  if (!actor || actor === 'web:unknown') return undefined
  return actor
}

/** `usr_*` rows must not mix with legacy ownerless (`creator_id = ''`) rows. */
export function ownerIdIsAccount(ownerId: string): boolean {
  return ownerId.startsWith('usr_')
}

export function scopeOwnsThread(
  scope: MemberScope,
  threadId: string,
  platform = 'web',
): boolean {
  if (scope.kind === 'admin') return true
  if (scope.kind !== 'user') return false
  if (platform !== 'web') return false
  return scope.threadIds.includes(threadId)
}

export function scopeOwnsThreadKey(scope: MemberScope, threadKey: string): boolean {
  if (scope.kind === 'admin') return true
  if (scope.kind !== 'user') return false
  return scope.threadKeys.includes(threadKey)
}

export function jobVisibleToScope(
  job: { creator_id?: string | null; thread_key?: string | null },
  scope: MemberScope,
): boolean {
  if (scope.kind === 'admin') return true
  if (scope.kind !== 'user') return false
  const creator = job.creator_id || ''
  if (creator && creator === scope.userId) return true
  const key = job.thread_key || ''
  return Boolean(key) && scope.threadKeys.includes(key)
}

/**
 * Portal / loop mutations: the live composer thread may be an empty shell
 * that listUserWebSessions skips. Missing session + web platform → allow
 * (brand-new chat). A session owned by someone else → deny.
 */
export async function webThreadAccessible(
  scope: MemberScope,
  threadId: string,
  platform = 'web',
  channelId = 'web',
): Promise<boolean> {
  if (scope.kind === 'admin') return true
  if (scope.kind !== 'user') return false
  if (platform === 'web' && scope.threadIds.includes(threadId)) return true
  const { sessionManager } = await import('../core/session.js')
  const session = await sessionManager.getExistingSession(platform, channelId, threadId)
  const owner = session?.ownerUserId
  if (owner && owner === scope.userId) return true
  if (!owner && platform === 'web' && channelId === 'web' && !session) return true
  return false
}

export async function requireWebThreadAccess(
  req: IncomingMessage,
  res: ServerResponse,
  threadId: string,
  platform = 'web',
  channelId = 'web',
): Promise<boolean> {
  const scope = await resolveMemberScope(req)
  if (await webThreadAccessible(scope, threadId, platform, channelId)) return true
  sendForbidden(res)
  return false
}
