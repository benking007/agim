import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshJobStatus, type RefreshableJobMeta } from './bgjob-status.js'

describe('refreshJobStatus', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  function seed(root: string, id: string, meta: Record<string, unknown>, exitCode?: string): void {
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'meta.json'), JSON.stringify({ id, ...meta }, null, 2))
    if (exitCode !== undefined) writeFileSync(join(root, id, 'exit_code'), exitCode)
  }

  it('promotes running → completed when process gone and exit_code=0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bgjob-status-'))
    dirs.push(root)
    // PID that cannot be alive (kernel reserved / never assigned to user jobs)
    seed(root, 'job-ok', { status: 'running', pid: 1_000_000_007, exit_code: null }, '0')
    const input: RefreshableJobMeta = {
      id: 'job-ok',
      status: 'running',
      pid: 1_000_000_007,
      exit_code: null,
    }
    const meta = await refreshJobStatus(root, input)
    expect(meta.status).toBe('completed')
    expect(meta.exit_code).toBe(0)
    expect(meta.ended_at).toBeTruthy()
    const disk = JSON.parse(readFileSync(join(root, 'job-ok', 'meta.json'), 'utf8')) as {
      status?: string
      exit_code?: number
    }
    expect(disk.status).toBe('completed')
    expect(disk.exit_code).toBe(0)
  })

  it('promotes running → failed when process gone and exit_code nonzero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bgjob-status-fail-'))
    dirs.push(root)
    seed(root, 'job-fail', { status: 'running', pid: 1_000_000_008 }, '7')
    const input: RefreshableJobMeta = {
      id: 'job-fail',
      status: 'running',
      pid: 1_000_000_008,
    }
    const meta = await refreshJobStatus(root, input)
    expect(meta.status).toBe('failed')
    expect(meta.exit_code).toBe(7)
  })

  it('leaves terminal status untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bgjob-status-term-'))
    dirs.push(root)
    const input: RefreshableJobMeta = {
      id: 'job-done',
      status: 'completed',
      pid: null,
      exit_code: 0,
    }
    const meta = await refreshJobStatus(root, input)
    expect(meta.status).toBe('completed')
  })

  it('treats missing exit_code file as failed (-1) when pid gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bgjob-status-missing-'))
    dirs.push(root)
    seed(root, 'job-miss', { status: 'running', pid: 1_000_000_009 })
    const input: RefreshableJobMeta = {
      id: 'job-miss',
      status: 'running',
      pid: 1_000_000_009,
    }
    const meta = await refreshJobStatus(root, input)
    expect(meta.status).toBe('failed')
    expect(meta.exit_code).toBe(-1)
  })
})
