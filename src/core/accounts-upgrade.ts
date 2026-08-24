// First-admin adoption for upgrades from pre-account installs.
// Old instances had no users — everyone on the box was an operator.
// The first registered account becomes that operator: existing API
// tokens and already-connected messengers attach to them.

import { attachOrphanTokens } from './access-token.js'
import { claimMessengerSlots, listBindings, PLATFORM_CHANNEL } from './im-bind.js'
import { getLiveConfig } from './live-config.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'accounts-upgrade' })

export function adoptLegacyInstall(userId: string): { tokens: number; messengers: number } {
  let tokens = 0
  try {
    tokens = attachOrphanTokens(userId)
  } catch { /* tokens.json optional on a brand-new box */ }

  let messengers = 0
  try {
    const cfg = getLiveConfig()
    const slots = Array.isArray(cfg?.messengers)
      ? cfg.messengers.filter((m): m is string => typeof m === 'string')
      : []
    if (slots.length > 0) claimMessengerSlots(slots, userId)
    messengers = listBindings({ userId }).filter((b) => b.imUserId === PLATFORM_CHANNEL).length
  } catch { /* live config may be unset in unit tests */ }

  log.info({
    event: 'accounts.legacy_adopted',
    userId,
    tokens,
    messengers,
  }, 'first admin adopted legacy tokens and messengers')
  return { tokens, messengers }
}
