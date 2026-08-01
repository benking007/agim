import { describe, expect, it } from 'bun:test'
import type { Logger } from 'pino'
import type { RouteContext } from '../router.js'
import {
  handleRestartCommand,
  WEB_CHAT_RESTART_REFUSED,
} from './service.js'

function makeCtx(over: Partial<RouteContext> = {}): RouteContext {
  return {
    channelId: 'web',
    threadId: 't1',
    platform: 'web',
    userId: 'web:client-1',
    defaultAgent: 'agim',
    traceId: 'tr',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}),
    } as unknown as Logger,
    ...over,
  }
}

describe('handleRestartCommand — web / m-chat guard', () => {
  it('refuses platform=web (covers console and Portal /m/chat)', async () => {
    const msg = await handleRestartCommand('', makeCtx({
      platform: 'web',
      userId: 'web:promoted-admin',
    }))
    expect(msg).toBe(WEB_CHAT_RESTART_REFUSED)
    expect(msg).toMatch(/不能重启|not allowed/i)
    expect(msg).toMatch(/Settings|设置/)
  })

  it('refuses web regardless of threadId', async () => {
    const msg = await handleRestartCommand('-y', makeCtx({
      platform: 'web',
      channelId: 'web',
      threadId: 'm-portal-thread',
    }))
    expect(msg).toBe(WEB_CHAT_RESTART_REFUSED)
  })

  it('non-web non-admin still gets admin denial (not the web refuse)', async () => {
    const msg = await handleRestartCommand('', makeCtx({
      platform: 'telegram',
      channelId: 'c',
      userId: '12345',
      threadId: 't',
    }))
    expect(msg).not.toBe(WEB_CHAT_RESTART_REFUSED)
    expect(msg).toMatch(/admin|管理员|无权|not allowed|denied|allowlist/i)
  })
})
