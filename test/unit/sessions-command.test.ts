// Unit tests for /sessions — verifies response formatting, graceful
// dashboard failures, and AGIM_DASHBOARD_URL override without depending
// on a real listener, DNS, or wall-clock timeout.

import { describe, it, expect, afterAll, beforeEach } from 'bun:test'
import { handleSessionsCommand } from '../../src/core/commands/sessions'
import type { RouteContext } from '../../src/core/router'
import type { Logger } from 'pino'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger

const ctx: RouteContext = {
  platform: 'test', channelId: 'c', threadId: 't',
  defaultAgent: 'opencode', traceId: 'tr', logger: noopLogger, userId: 'u',
}

const ORIG_URL = process.env.AGIM_DASHBOARD_URL

afterAll(() => {
  if (ORIG_URL === undefined) delete process.env.AGIM_DASHBOARD_URL
  else process.env.AGIM_DASHBOARD_URL = ORIG_URL
})

beforeEach(() => {
  process.env.AGIM_DASHBOARD_URL = 'http://dashboard.test'
})

describe('/sessions', () => {
  it('lists sessions on a healthy dashboard', async () => {
    const out = await handleSessionsCommand('', ctx, async () => ({
      sessions: [
        { title: 'first', created: new Date().toISOString(), msgCount: 12, ageHours: 0.5 },
        { title: 'second', created: new Date().toISOString(), msgCount: 3, ageHours: 5 },
      ],
    }))
    expect(out).toContain('first')
    expect(out).toContain('second')
  })

  it('shows empty when dashboard returns no sessions', async () => {
    const out = await handleSessionsCommand('', ctx, async () => ({ sessions: [] }))
    expect(out).toContain('暂无活跃会话')
  })

  it('reports refused when dashboard host is unreachable', async () => {
    const out = await handleSessionsCommand('', ctx, async () => {
      throw new Error('connect ECONNREFUSED')
    })
    expect(out).toContain('无法连接')
  })

  it('reports timeout when dashboard does not respond', async () => {
    const out = await handleSessionsCommand('', ctx, async () => {
      throw new Error('timeout')
    })
    expect(out).toContain('超时')
  })

  it('reports invalid JSON on garbage response', async () => {
    const out = await handleSessionsCommand('', ctx, async () => {
      throw new Error('invalid JSON')
    })
    expect(out).toContain('非 JSON')
  })

  it('honors AGIM_DASHBOARD_URL override', async () => {
    process.env.AGIM_DASHBOARD_URL = 'http://127.0.0.1:1'
    let requestedUrl = ''
    const out = await handleSessionsCommand('', ctx, async (url) => {
      requestedUrl = url
      throw new Error('connect ECONNREFUSED')
    })
    expect(requestedUrl).toBe('http://127.0.0.1:1/api/sessions/list?limit=10')
    expect(out).toContain('http://127.0.0.1:1')
  })
})
