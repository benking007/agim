import { afterEach, describe, expect, it } from 'bun:test'
import {
  _setTestLiveSubagents,
  emptyLoopUsage,
  formatLoopEndedSummary,
  getLoopUxBucket,
  loopUxBucketLabel,
  toLoopStatusDto,
  type LoopRun,
} from './loop-run.js'
import { getLoopEvaluatorMode } from './loop-evaluator.js'

function baseRun(over: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionKey: 'web__web__t1',
    platform: 'web',
    channelId: 'web',
    threadId: 't1',
    focusSnapshot: 'Ship',
    openedFocus: false,
    status: 'planning',
    round: 1,
    maxRounds: 5,
    mission: {
      objective: '修好登录',
      exit: { description: '验收通过', maxRounds: 5, onFocusOff: 'cancel' },
    },
    dispatchesThisRound: 0,
    usage: emptyLoopUsage(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timeline: [],
    ...over,
  }
}

describe('loop UX buckets (R5)', () => {
  afterEach(() => {
    _setTestLiveSubagents(null)
  })

  it('maps statuses to 待对焦/待派工/待验收', () => {
    _setTestLiveSubagents(false)
    expect(getLoopUxBucket(baseRun({ status: 'aligning' }))).toBe('aligning')
    expect(getLoopUxBucket(baseRun({ status: 'planning', dispatchesThisRound: 0 }))).toBe('dispatch')
    expect(getLoopUxBucket(baseRun({ status: 'dispatching', dispatchesThisRound: 0 }))).toBe('dispatch')
    expect(getLoopUxBucket(baseRun({ status: 'dispatching', dispatchesThisRound: 2 }))).toBe('verify')
    expect(getLoopUxBucket(baseRun({ status: 'verifying' }))).toBe('verify')
    expect(getLoopUxBucket(baseRun({ status: 'ended' }))).toBe('ended')
    expect(loopUxBucketLabel('aligning')).toBe('待对焦')
    expect(loopUxBucketLabel('dispatch')).toBe('待派工')
    expect(loopUxBucketLabel('verify')).toBe('待验收')
  })

  it('stays in dispatch while Subagents are live (no early verify)', () => {
    _setTestLiveSubagents(true)
    expect(getLoopUxBucket(baseRun({
      status: 'dispatching',
      dispatchesThisRound: 2,
    }))).toBe('dispatch')
    const dto = toLoopStatusDto(baseRun({
      status: 'dispatching',
      dispatchesThisRound: 2,
    }))
    expect(dto.bucket).toBe('dispatch')
    expect(dto.liveSubagents).toBeGreaterThan(0)
    expect(dto.canVerify).toBe(false)
  })

  it('toLoopStatusDto exposes bucket + mission fields', () => {
    _setTestLiveSubagents(false)
    const dto = toLoopStatusDto(baseRun({ dispatchesThisRound: 1, status: 'dispatching' }))
    expect(dto.bucket).toBe('verify')
    expect(dto.bucketLabel).toBe('待验收')
    expect(dto.canVerify).toBe(true)
    expect(dto.liveSubagents).toBe(0)
    expect(dto.objective).toBe('修好登录')
    expect(dto.active).toBe(true)
  })

  it('formatLoopEndedSummary for objective_met', () => {
    const text = formatLoopEndedSummary(baseRun({
      status: 'ended',
      endReason: 'objective_met',
      usage: { dispatchCount: 3, evaluatorCount: 1, continueCount: 1, reviseCount: 0 },
      lastVerification: {
        at: Date.now(),
        met: true,
        summary: '回归绿了',
      },
    }))
    expect(text).toContain('达标结束')
    expect(text).toContain('修好登录')
    expect(text).toContain('回归绿了')
    expect(text).toContain('派工 3')
    expect(text).toContain('独立验收 1')
  })

  it('toLoopStatusDto includes usage', () => {
    const dto = toLoopStatusDto(baseRun({
      usage: { dispatchCount: 2, evaluatorCount: 0, continueCount: 0, reviseCount: 1 },
    }))
    expect(dto.usage.dispatchCount).toBe(2)
    expect(dto.usage.reviseCount).toBe(1)
  })
})

describe('loop evaluator mode', () => {
  it('reads AGIM_LOOP_EVALUATOR', () => {
    const prev = process.env.AGIM_LOOP_EVALUATOR
    try {
      process.env.AGIM_LOOP_EVALUATOR = 'off'
      expect(getLoopEvaluatorMode()).toBe('off')
      process.env.AGIM_LOOP_EVALUATOR = 'on'
      expect(getLoopEvaluatorMode()).toBe('on')
      delete process.env.AGIM_LOOP_EVALUATOR
      expect(getLoopEvaluatorMode()).toBe('auto')
    } finally {
      if (prev === undefined) delete process.env.AGIM_LOOP_EVALUATOR
      else process.env.AGIM_LOOP_EVALUATOR = prev
    }
  })
})
