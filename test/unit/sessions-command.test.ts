// Unit tests for /sessions — local SessionManager listing, not an
// external dashboard. The command accepts an injected lister so we
// don't depend on ~/.agim/sessions disk state.

import { describe, it, expect } from 'bun:test'
import { handleSessionsCommand } from '../../src/core/commands/sessions'
import type { RouteContext } from '../../src/core/router'
import type { RecentSessionSummary } from '../../src/core/session'
import type { Logger } from 'pino'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger

const ctx: RouteContext = {
  platform: 'wechat', channelId: 'c', threadId: 't',
  defaultAgent: 'agim', traceId: 'tr', logger: noopLogger, userId: 'u',
}

function row(overrides: Partial<RecentSessionSummary> = {}): RecentSessionSummary {
  return {
    platform: 'wechat',
    channelId: 'c1',
    threadId: 'alpha',
    agent: 'agim',
    lastActivity: new Date('2026-08-15T08:00:00Z'),
    turns: 12,
    ...overrides,
  }
}

describe('/sessions', () => {
  it('lists recent local sessions for the current platform', async () => {
    const out = await handleSessionsCommand('', ctx, async () => [
      row({ threadId: 'first', agent: 'agim', turns: 12, lastActivity: new Date() }),
      row({
        threadId: 'second',
        agent: 'claude-code',
        turns: 3,
        lastActivity: new Date(Date.now() - 5 * 3600_000),
      }),
    ])
    expect(out).toContain('first')
    expect(out).toContain('second')
    expect(out).toContain('agim')
    expect(out).toContain('claude-code')
    expect(out).toContain('12轮')
    expect(out).toContain('<1h')
    expect(out).toContain('5h')
  })

  it('shows empty when this platform has no sessions', async () => {
    const out = await handleSessionsCommand('', ctx, async () => [])
    expect(out).toContain('暂无活跃会话')
  })

  it('asks the lister for the current platform and a limit of 10', async () => {
    let seen: { platform?: string; limit?: number } | undefined
    await handleSessionsCommand('', ctx, async (opts) => {
      seen = opts
      return []
    })
    expect(seen).toEqual({ platform: 'wechat', limit: 10 })
  })
})
