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
  handleAskButton,
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

/**
 * Unified `ask:` button-tap handler. Maps handleAskButton's outcome to a
 * Telegram ack + an optional in-place card edit:
 *   - resolved      → strip the card to a receipt (editChoiceCard) + ack ✓
 *   - rerender      → re-render the toggle keyboard in place (updateChoiceCard)
 *   - await-custom  → prompt the user to type their answer
 *   - invalid       → ack the hint as a toast (card stays put)
 *   - unmatched     → ack "已失效"
 * Acks regardless so the user's spinner clears. Shared by approval-router
 * (the de-facto unified dispatcher) and this module's own binder.
 */
export async function handleAskButtonClick(
  platform: string,
  cb: ButtonCallback,
  resolveMessenger: (platform: string) => MessengerAdapter | undefined,
): Promise<void> {
  const outcome = handleAskButton(cb.data)
  const m = resolveMessenger(platform)
  try {
    switch (outcome.kind) {
      case 'resolved':
        if (m?.editChoiceCard && cb.messageId) {
          await m.editChoiceCard(cb.threadId, cb.messageId, outcome.finalText).catch(() => {})
        }
        await cb.ack('✓')
        break
      case 'rerender':
        if (m?.updateChoiceCard && cb.messageId) {
          await m.updateChoiceCard(cb.threadId, cb.messageId, outcome.card)
        }
        await cb.ack()
        break
      case 'await-custom':
        if (m?.sendMessage) await m.sendMessage(cb.threadId, outcome.prompt)
        await cb.ack('请输入')
        break
      case 'invalid':
        await cb.ack(outcome.hint)
        break
      case 'unmatched':
        await cb.ack('已失效')
        break
    }
  } catch (err) {
    log.warn({ event: 'ask.router.button_error', platform, err: err instanceof Error ? err.message : String(err) })
    try { await cb.ack() } catch { /* best-effort */ }
  }
  log.info({ event: 'ask.router.button', platform, kind: outcome.kind })
}

/** Telegram / Feishu / Discord button-tap callback dispatcher (used when
 *  this router's install() binds handlers directly). Recognises only our
 *  `ask:` prefix and delegates to handleAskButtonClick; approval-router
 *  (parallel registration) handles `apv:` prefixed events. */
async function handleButtonCallback(platform: string, cb: ButtonCallback): Promise<void> {
  if (!cb.data?.startsWith('ask:')) return
  if (!installed) return
  await handleAskButtonClick(platform, cb, installed.resolveMessenger)
}
