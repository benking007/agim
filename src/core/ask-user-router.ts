// ask-user-router — wire ask-user-rpc's pending Map into IM messengers
// (P0 #5).
//
// Two integration points:
//
//   1. **Inbound text intercept** — cli.ts onMessage calls
//      `tryHandleAskReply(threadKey, text)` BEFORE routing to the
//      normal agent path. If a pending ask exists on that thread AND
//      the text matches one of the choices, we resolve it and tell cli
//      to stop. Non-matching text passes through to the agent (user
//      changed topic; the ask either times out on its own or the agent
//      asks again).
//
//   2. **Button callback** — for messengers with native inline buttons
//      (Telegram now; Feishu in flight), bind a handler that parses
//      our `ask:<reqId>:<index>` data field and resolves the pending.
//      Same install / bindButtonHandlerForPlatform pattern as
//      approval-router so cli can call both in the same boot block.
//
// This module is intentionally tiny — all the state lives in
// ask-user-rpc.ts. Here we just translate between IM events and the
// pending-resolver API.

import type { MessengerAdapter, ButtonCallback } from './types.js'
import { logger as rootLogger } from './logger.js'
import {
  tryResolvePendingAsk,
  tryResolvePendingAskByButton,
} from './ask-user-rpc.js'

const log = rootLogger.child({ component: 'ask-user-router' })

export interface InstallOptions {
  /** Resolve a messenger by platform name; same shape as approval-router's. */
  resolveMessenger: (platform: string) => MessengerAdapter | undefined
  /** Platforms to bind onButtonCallback for. Defaults to a sensible
   *  set; adapters without onButtonCallback are silently skipped. */
  buttonCallbackPlatforms?: string[]
}

const DEFAULT_PLATFORMS = ['telegram', 'feishu', 'discord', 'dingtalk', 'wechat-ilink', 'web']

let installed: InstallOptions | null = null

/** Install the router. Idempotent — re-calling rebinds button handlers. */
export function install(opts: InstallOptions): void {
  installed = opts
  for (const platform of opts.buttonCallbackPlatforms ?? DEFAULT_PLATFORMS) {
    bindButtonHandlerForPlatform(platform)
  }
}

/** Rebind a single platform's button handler. Used by web/server.ts
 *  when it registers its messenger AFTER install(). */
export function bindButtonHandlerForPlatform(platform: string): void {
  if (!installed) return
  const m = installed.resolveMessenger(platform)
  if (!m?.onButtonCallback) return
  m.onButtonCallback(async (cb) => handleButtonCallback(platform, cb))
  log.info({ event: 'ask.router.button_handler_bound', platform })
}

/**
 * Inbound-text intercept. Called from cli.ts onMessage before the agent
 * router runs. Returns true iff this message resolved a pending ask
 * (caller should stop).
 *
 * threadKey is `platform:channelId:threadId` — same shape approval-
 * router uses; we split it back into the three components here so the
 * underlying pending map can look up by composite key.
 */
export function tryHandleAskReply(platform: string, channelId: string, threadId: string, text: string): boolean {
  return tryResolvePendingAsk(platform, channelId, threadId, text)
}

/** Telegram / Feishu / Discord button-tap callback dispatcher. Acks the
 *  tap regardless of whether we matched, so the user's spinner clears.
 *  We share onButtonCallback with approval-router (Telegram only fires
 *  ONE handler per chat at a time — that's why each registrar treats
 *  rebind as "replace previous"). To play nice with approval-router,
 *  we recognise our own `ask:` prefix and IGNORE anything else; the
 *  other router does the same. Adapters that need to host both routers
 *  for one chat type should chain handlers via the messenger-side
 *  composition API (TBD; first real-world consumer drives the design).
 */
async function handleButtonCallback(platform: string, cb: ButtonCallback): Promise<void> {
  if (!cb.data?.startsWith('ask:')) {
    // Not ours — silently skip. approval-router (parallel registration)
    // handles `apv:` prefixed events.
    return
  }
  const resolved = tryResolvePendingAskByButton(cb.data)
  try {
    await cb.ack(resolved ? '✓' : '已失效')
  } catch { /* ack errors are best-effort */ }
  log.info({
    event: resolved ? 'ask.router.button_resolved' : 'ask.router.button_unmatched',
    platform, data: cb.data,
  })
}
