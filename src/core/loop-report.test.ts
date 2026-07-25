import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildLoopDetailReport,
  filterJobsByLoopWindow,
  generateLoopDetailReport,
  resolveLoopReportsDir,
} from './loop-report.js'
import type { LoopRun } from './loop-run.js'
import { emptyLoopUsage } from './loop-run.js'
import type { Job } from './job-board.js'

function makeRun(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'loop-test-1',
    sessionKey: 'web__web__t1',
    platform: 'web',
    channelId: 'web',
    threadId: 't1',
    focusSnapshot: 'focus',
    openedFocus: false,
    status: 'ended',
    endReason: 'objective_met',
    round: 4,
    maxRounds: 12,
    mission: {
      objective: '分析中证500',
      exit: { description: '拿到明确结论', maxRounds: 12, onFocusOff: 'cancel' },
    },
    dispatchesThisRound: 0,
    roundJobIds: [],
    loopJobIds: [],
    usage: emptyLoopUsage(),
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    timeline: [],
    lastVerification: {
      at: Date.now(),
      met: true,
      summary: '维持清仓建议',
    },
    ...overrides,
  }
}

function makeJob(id: number, result: string): Job {
  return {
    id,
    status: 'completed',
    agent: 'agim',
    prompt: `task-${id}: research sector`,
    result,
    error: null,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    creator_id: '',
    workspace_id: '',
    thread_key: 'web:web:t1',
    kind: 'inline',
    started_at: null,
    delivered_at: null,
    replaced_by: null,
    last_outbox_id: null,
    parent_id: 1,
    call_depth: 1,
  }
}

describe('loop-report', () => {
  let tmp: string
  const prevReports = process.env.AGIM_LOOP_REPORTS_DIR
  const prevLoops = process.env.AGIM_LOOPS_DIR

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agim-loop-report-'))
    process.env.AGIM_LOOP_REPORTS_DIR = join(tmp, 'reports')
    process.env.AGIM_LOOPS_DIR = join(tmp, 'loops')
  })

  afterEach(() => {
    if (prevReports === undefined) delete process.env.AGIM_LOOP_REPORTS_DIR
    else process.env.AGIM_LOOP_REPORTS_DIR = prevReports
    if (prevLoops === undefined) delete process.env.AGIM_LOOPS_DIR
    else process.env.AGIM_LOOPS_DIR = prevLoops
    rmSync(tmp, { recursive: true, force: true })
  })

  it('buildLoopDetailReport includes objective and each subagent section', () => {
    const md = buildLoopDetailReport(makeRun(), [
      makeJob(10, 'tech weight 25.7%'),
      makeJob(11, 'ETF score table'),
    ])
    expect(md).toContain('分析中证500')
    expect(md).toContain('子代理 #10')
    expect(md).toContain('tech weight 25.7%')
    expect(md).toContain('ETF score table')
    expect(md).toContain('共 2 个')
  })

  it('generateLoopDetailReport writes file when loop json exists', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(tmp, 'loops'), { recursive: true })
    const run = makeRun({ roundJobIds: [] })
    writeFileSync(join(tmp, 'loops', 'web__web__t1.json'), JSON.stringify(run), 'utf-8')

    const gen = generateLoopDetailReport('web', 'web', 't1')
    expect(gen.ok).toBe(true)
    if (!gen.ok) return
    expect(gen.path).toContain('.md')
    const disk = readFileSync(gen.path, 'utf-8')
    expect(disk).toContain('Loop 详细分析报告')
    expect(gen.chatMarkdown).toContain(gen.path)
  })

  it('generateLoopDetailReport refuses non-ended loop', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(tmp, 'loops'), { recursive: true })
    writeFileSync(
      join(tmp, 'loops', 'web__web__t1.json'),
      JSON.stringify(makeRun({ status: 'pending_user_confirm' })),
      'utf-8',
    )
    const gen = generateLoopDetailReport('web', 'web', 't1')
    expect(gen.ok).toBe(false)
    if (gen.ok) return
    expect(gen.error).toBe('loop_not_ended')
  })

  it('default reports dir is <agent-cwd>/PROJECTS/loops', () => {
    delete process.env.AGIM_LOOP_REPORTS_DIR
    const prevWs = process.env.AGIM_WORKSPACES_ROOT
    process.env.AGIM_WORKSPACES_ROOT = join(tmp, 'workspaces')
    try {
      expect(resolveLoopReportsDir()).toBe(
        join(tmp, 'workspaces', 'agim', 'PROJECTS', 'loops'),
      )
    } finally {
      if (prevWs === undefined) delete process.env.AGIM_WORKSPACES_ROOT
      else process.env.AGIM_WORKSPACES_ROOT = prevWs
      process.env.AGIM_LOOP_REPORTS_DIR = join(tmp, 'reports')
    }
  })

  it('filterJobsByLoopWindow excludes jobs from earlier Loops on same thread', () => {
    const now = Date.now()
    const run = makeRun({ createdAt: now - 30_000, updatedAt: now })
    const kept = makeJob(20, 'this loop')
    kept.created_at = new Date(now - 10_000).toISOString()
    const older = makeJob(19, 'previous loop')
    older.created_at = new Date(now - 120_000).toISOString()
    const filtered = filterJobsByLoopWindow([older, kept], run)
    expect(filtered.map((j) => j.id)).toEqual([20])
  })
})
