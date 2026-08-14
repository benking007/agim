// /step-reflect — persist both true and false (unlike /plan which drops false).

import { describe, it, expect, afterEach } from 'bun:test'
import { join } from 'node:path'
import { unlink, readdir, readFile } from 'node:fs/promises'
import { sessionManager } from '../session.js'
import { handleStepReflectCommand } from './step-reflect.js'
import { parseMessage } from '../router.js'
import { AGIM_HOME } from '../agim-paths.js'
import type { RouteContext } from '../router.js'
import type { Logger } from 'pino'

const PLATFORM = 'stepreflecttest'
const SESSIONS_DIR = join(AGIM_HOME, 'sessions')

function uid(): string { return Math.random().toString(36).slice(2, 10) }

async function cleanupTestSessions(): Promise<void> {
  let names: string[]
  try { names = await readdir(SESSIONS_DIR) } catch { return }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(SESSIONS_DIR, name), 'utf-8')
      const parsed = JSON.parse(raw) as { platform?: string }
      if (parsed.platform === PLATFORM) {
        await unlink(join(SESSIONS_DIR, name)).catch(() => {})
        await unlink(join(SESSIONS_DIR, name.replace(/\.json$/, '.log'))).catch(() => {})
      }
    } catch { /* ignore */ }
  }
}

function makeCtx(channelId: string, threadId: string): RouteContext {
  return {
    channelId, threadId, platform: PLATFORM,
    defaultAgent: 'agim', traceId: 't',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) } as unknown as Logger,
  }
}

afterEach(async () => {
  delete process.env.AGIM_STEP_REFLECT
  await cleanupTestSessions()
})

describe('parseMessage /step-reflect', () => {
  it('parses on/off and Chinese aliases', () => {
    expect(parseMessage('/step-reflect on')).toEqual({ type: 'step-reflect', args: 'on' })
    expect(parseMessage('/步思 off')).toEqual({ type: 'step-reflect', args: 'off' })
    expect(parseMessage('/一步一想')).toEqual({ type: 'step-reflect', args: '' })
  })
})

describe('handleStepReflectCommand', () => {
  it('shows off + usage on a fresh session', async () => {
    const ctx = makeCtx(uid(), uid())
    await sessionManager.getOrCreateSession(ctx.platform, ctx.channelId, ctx.threadId, 'agim')
    const out = await handleStepReflectCommand('', ctx)
    expect(out).toContain('一步一想')
    expect(out).toContain('off')
    expect(out).toContain('/step-reflect on')
    expect(out).toContain('DeepSeek')
  })

  it('/step-reflect on persists true', async () => {
    const ctx = makeCtx(uid(), uid())
    const out = await handleStepReflectCommand('on', ctx)
    expect(out).toContain('已开启')
    expect(out).toContain('思考')
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.stepReflect).toBe(true)
  })

  it('/step-reflect off persists false (does not drop the field)', async () => {
    const ctx = makeCtx(uid(), uid())
    process.env.AGIM_STEP_REFLECT = 'on'
    await handleStepReflectCommand('off', ctx)
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.stepReflect).toBe(false)
  })

  it('is idempotent on / off', async () => {
    const ctx = makeCtx(uid(), uid())
    await handleStepReflectCommand('on', ctx)
    const again = await handleStepReflectCommand('on', ctx)
    expect(again).toContain('无变化')
    await handleStepReflectCommand('off', ctx)
    const offAgain = await handleStepReflectCommand('off', ctx)
    expect(offAgain).toContain('本来就是关闭')
  })

  it('rejects unknown tokens', async () => {
    const ctx = makeCtx(uid(), uid())
    const out = await handleStepReflectCommand('maybe', ctx)
    expect(out).toContain('无效参数')
  })

  it('AGIM_STEP_REFLECT=disabled short-circuits', async () => {
    const ctx = makeCtx(uid(), uid())
    process.env.AGIM_STEP_REFLECT = 'disabled'
    const out = await handleStepReflectCommand('on', ctx)
    expect(out).toContain('禁用')
    const session = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
    expect(session?.stepReflect).toBeUndefined()
  })
})
