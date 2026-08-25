/**
 * get-history rekey: adopt a client-supplied web-* thread only when this
 * account owns it (or it is still unclaimed). Disk ownerUserId wins even
 * when the in-memory token map is empty after a process restart.
 */

import { sessionManager } from '../core/session.js'
import { logger as rootLogger } from '../core/logger.js'

const webLog = rootLogger.child({ component: 'web' })

const WEB_THREAD_RE = /^web-[A-Za-z0-9_-]{4,64}$/

export interface ThreadOwnerStore {
  get(threadId: string): string | undefined
  set(threadId: string, tokenId: string): void
  delete(threadId: string): void
  rekey?(oldId: string, newId: string): void
}

export async function applyWebHistoryRekey(opts: {
  wantedThreadId: string
  clientId: string
  accountUserId?: string
  tokenId?: string
  threadOwners?: ThreadOwnerStore
  onAdopt: (nextThreadId: string) => void
  onRefuse: () => Promise<void>
}): Promise<'refused' | 'ok'> {
  const wantedThreadId = opts.wantedThreadId.trim()
  if (!wantedThreadId || !WEB_THREAD_RE.test(wantedThreadId) || wantedThreadId === opts.clientId) {
    return 'ok'
  }

  const peer = opts.accountUserId || opts.tokenId || 'anon'
  const owner = opts.threadOwners?.get(wantedThreadId)
  const persistOwnerRaw = (await sessionManager.getExistingSession('web', 'web', wantedThreadId))?.ownerUserId
  const persistOwner = typeof persistOwnerRaw === 'string' && persistOwnerRaw.trim()
    ? persistOwnerRaw.trim()
    : ''
  const sameAccount = Boolean(opts.accountUserId && persistOwner === opts.accountUserId)
  const memoryForeign = owner !== undefined && owner !== peer && !sameAccount
  const persistForeign = persistOwner !== '' && persistOwner !== (opts.accountUserId ?? '')

  if (memoryForeign || persistForeign) {
    webLog.warn({
      event: 'web.session.rekey_denied',
      clientId: opts.clientId,
      wantedThreadId,
      peer,
      owner,
      persistOwner,
    }, 'WS get-history rekey refused — starting fresh thread for this token')
    await opts.onRefuse()
    return 'refused'
  }

  if (opts.accountUserId) {
    const claimed = await sessionManager.claimWebSessionOwner(wantedThreadId, opts.accountUserId)
    if (!claimed) {
      webLog.warn({
        event: 'web.session.rekey_denied',
        clientId: opts.clientId,
        wantedThreadId,
        peer,
        persistOwner,
      }, 'WS get-history claim refused — starting fresh thread')
      await opts.onRefuse()
      return 'refused'
    }
  }

  opts.onAdopt(wantedThreadId)
  if (opts.threadOwners && (owner === undefined || sameAccount || owner === peer)) {
    opts.threadOwners.set(wantedThreadId, peer)
  }
  webLog.info({
    clientId: wantedThreadId,
    oldId: opts.clientId,
    event: 'web.session.rekey',
  }, 'WS client adopted persisted threadId')
  return 'ok'
}
