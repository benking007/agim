import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { sessionManager } from '../session.js'
import type { RouteContext } from '../router.js'
import { handleLoopCommand } from './loop.js'

const TMP = mkdtempSync(join(tmpdir(), 'agim-loop-parent-'))
process.env.AGIM_LOOPS_DIR = join(TMP, 'loops')

const PLATFORM = 'loopparenttest'

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function makeCtx(channelId: string, threadId: string, defaultAgent = 'agim'): RouteContext {
  return {
    channelId,
    threadId,
    platform: PLATFORM,
    defaultAgent,
    traceId: 't',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({}),
    } as unknown as Logger,
  }
}

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('handleLoopCommand parent-agent gate', () => {
  it('blocks /loop start when sticky agent is codex', async () => {
    const ctx = makeCtx(uid(), uid(), 'codex')
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'codex')
    const out = await handleLoopCommand('研究黄金；退出：不少于3轮并得出结论', ctx)
    expect(out).toContain('Agim Agent')
    expect(out).toContain('codex')
    expect(out).toContain('E2BIG')
  })

  it('allows /loop help and status without Agim parent', async () => {
    const ctx = makeCtx(uid(), uid(), 'codex')
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'codex')
    const help = await handleLoopCommand('help', ctx)
    expect(help).toContain('Agim Agent')
    expect(help).toContain('父编排')

    const status = await handleLoopCommand('status', ctx)
    expect(status).toContain('还没有 Loop')
  })

  it('does not apply parent gate when sticky agent is agim', async () => {
    const ctx = makeCtx(uid(), uid(), 'agim')
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'agim')
    const out = await handleLoopCommand('修好登录；退出：验收通过或最多3轮', ctx)
    // Focus/SQLite may be unavailable under Bun — only assert the parent gate
    // did not fire (CLI sticky would return formatLoopParentRequired).
    expect(out).not.toContain('父编排必须用')
    expect(out).not.toContain('spawn E2BIG')
  })
})
