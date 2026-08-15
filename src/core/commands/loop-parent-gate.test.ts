import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { sessionManager } from '../session.js'
import type { RouteContext } from '../router.js'
import { handleLoopCommand } from './loop.js'
import { getLoopRun } from '../loop-run.js'

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

  // ─── P1-2b: IM confirm end|continue on pending_user_confirm ────────────
  function seedPending(platform: string, channelId: string, threadId: string): void {
    const sessionKey = `${platform}__${channelId}__${threadId}`
    const dir = process.env.AGIM_LOOPS_DIR!
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const now = Date.now()
    writeFileSync(join(dir, `${sessionKey}.json`), JSON.stringify({
      id: `dddddddd-dddd-dddd-dddd-${threadId.slice(-12).padStart(12, '0')}`,
      sessionKey,
      platform,
      channelId,
      threadId,
      focusSnapshot: '修复登录',
      openedFocus: false,
      status: 'pending_user_confirm',
      round: 1,
      maxRounds: 3,
      mission: {
        objective: '修复登录超时',
        exit: { description: '验收通过或最多3轮', maxRounds: 3, onFocusOff: 'cancel' },
      },
      dispatchesThisRound: 1,
      usage: { dispatchCount: 1, evaluatorCount: 0, continueCount: 0, reviseCount: 0 },
      lastVerification: { at: now, met: true, summary: '登录已修复' },
      createdAt: now,
      updatedAt: now,
      confirmedAt: now,
      timeline: [],
    }), 'utf8')
  }

  it('confirm without action shows the end|continue hint on pending loop', async () => {
    const ctx = makeCtx(uid(), uid(), 'agim')
    seedPending(ctx.platform, ctx.channelId, ctx.threadId)
    const out = await handleLoopCommand('confirm', ctx)
    expect(out).toContain('confirm end')
    expect(out).toContain('confirm continue')
  })

  it('confirm end resolves the pending loop as objective_met (IM entry point)', async () => {
    const ctx = makeCtx(uid(), uid(), 'agim')
    seedPending(ctx.platform, ctx.channelId, ctx.threadId)
    const out = await handleLoopCommand('confirm end', ctx)
    expect(out).toContain('已结案')
    const run = getLoopRun(ctx.platform, ctx.channelId, ctx.threadId)
    expect(run?.status).toBe('ended')
    expect(run?.endReason).toBe('objective_met')
  })

  it('confirm continue advances to next planning round', async () => {
    const ctx = makeCtx(uid(), uid(), 'agim')
    seedPending(ctx.platform, ctx.channelId, ctx.threadId)
    const out = await handleLoopCommand('confirm continue 再补一轮回归', ctx)
    expect(out).toContain('planning')
    const run = getLoopRun(ctx.platform, ctx.channelId, ctx.threadId)
    expect(run?.status).toBe('planning')
    expect(run?.round).toBe(2)
    expect(run?.lastVerification?.nextDirection).toContain('再补一轮回归')
  })
})
