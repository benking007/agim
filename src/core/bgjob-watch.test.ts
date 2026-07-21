import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pushCalls: Array<{ text: string; ctx: unknown }> = []

mock.module('./push-rpc.js', () => ({
  handlePushOp: async (payload: { text?: unknown }, ctx: unknown) => {
    pushCalls.push({ text: String(payload.text ?? ''), ctx })
    return {
      ok: true as const,
      result: { outboxId: 1, immediate: true, targetThread: 'web::t1' },
    }
  },
}))

const { tickBgjobWatch, _resetBgjobWatchForTests } = await import('./bgjob-watch.js')

describe('bgjob-watch', () => {
  const dirs: string[] = []
  afterEach(() => {
    _resetBgjobWatchForTests()
    pushCalls.length = 0
    delete process.env.AGIM_BGJOB_AUTOSUMMARY
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  function seedJob(root: string, id: string, meta: Record<string, unknown>, log = 'line1\nline2\n'): void {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'meta.json'), JSON.stringify(meta, null, 2))
    writeFileSync(join(root, id, 'log.txt'), log)
    writeFileSync(join(root, 'index.json'), JSON.stringify({ jobs: [{ id, name: meta.name, started_at: meta.started_at }] }))
  }

  it('pushes L1 notify for terminal jobs with origin and stamps notified_at', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bgjob-watch-'))
    dirs.push(root)
    seedJob(root, 'job-1', {
      id: 'job-1',
      name: 'smoke',
      status: 'completed',
      exit_code: 0,
      log: join(root, 'job-1', 'log.txt'),
      origin: { platform: 'web', channelId: '', threadId: 't1', userId: 'web:t1' },
      notify_on_exit: true,
      notified_at: null,
    })

    const n = await tickBgjobWatch(root)
    expect(n).toBe(1)
    expect(pushCalls.length).toBe(1)
    expect(pushCalls[0]?.text).toContain('smoke')
    expect(pushCalls[0]?.text).toContain('已完成')

    const meta = JSON.parse(readFileSync(join(root, 'job-1', 'meta.json'), 'utf8')) as { notified_at?: string }
    expect(meta.notified_at).toBeTruthy()

    // Idempotent
    const n2 = await tickBgjobWatch(root)
    expect(n2).toBe(0)
    expect(pushCalls.length).toBe(1)
  })

  it('skips jobs without origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bgjob-watch-noorigin-'))
    dirs.push(root)
    seedJob(root, 'job-x', {
      id: 'job-x',
      name: 'orphan',
      status: 'failed',
      exit_code: 1,
      origin: null,
    })
    expect(await tickBgjobWatch(root)).toBe(0)
    expect(pushCalls.length).toBe(0)
  })

  it('sends L2 digest when AGIM_BGJOB_AUTOSUMMARY=on', async () => {
    process.env.AGIM_BGJOB_AUTOSUMMARY = 'on'
    const root = mkdtempSync(join(tmpdir(), 'bgjob-watch-l2-'))
    dirs.push(root)
    seedJob(root, 'job-2', {
      id: 'job-2',
      name: 'train',
      status: 'failed',
      exit_code: 2,
      log: join(root, 'job-2', 'log.txt'),
      origin: { platform: 'web', channelId: '', threadId: 't2', userId: 'u' },
      notify_on_exit: true,
    }, 'epoch fail\ntraceback\n')

    await tickBgjobWatch(root)
    expect(pushCalls.length).toBe(2)
    expect(pushCalls[1]?.text).toContain('日志摘要')
    expect(pushCalls[1]?.text).toContain('traceback')
  })
})
