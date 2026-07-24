import { describe, expect, it } from 'bun:test'
import {
  formatLoopEndedSummary,
  getLoopUxBucket,
  loopUxBucketLabel,
  toLoopStatusDto,
  type LoopRun,
} from './loop-run.js'

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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timeline: [],
    ...over,
  }
}

describe('loop UX buckets (R5)', () => {
  it('maps statuses to 对焦/派工/验收', () => {
    expect(getLoopUxBucket(baseRun({ status: 'aligning' }))).toBe('aligning')
    expect(getLoopUxBucket(baseRun({ status: 'planning', dispatchesThisRound: 0 }))).toBe('dispatch')
    expect(getLoopUxBucket(baseRun({ status: 'dispatching', dispatchesThisRound: 0 }))).toBe('dispatch')
    expect(getLoopUxBucket(baseRun({ status: 'dispatching', dispatchesThisRound: 2 }))).toBe('verify')
    expect(getLoopUxBucket(baseRun({ status: 'verifying' }))).toBe('verify')
    expect(getLoopUxBucket(baseRun({ status: 'ended' }))).toBe('ended')
    expect(loopUxBucketLabel('aligning')).toBe('对焦')
    expect(loopUxBucketLabel('dispatch')).toBe('派工')
    expect(loopUxBucketLabel('verify')).toBe('验收')
  })

  it('toLoopStatusDto exposes bucket + mission fields', () => {
    const dto = toLoopStatusDto(baseRun({ dispatchesThisRound: 1, status: 'dispatching' }))
    expect(dto.bucket).toBe('verify')
    expect(dto.bucketLabel).toBe('验收')
    expect(dto.objective).toBe('修好登录')
    expect(dto.active).toBe(true)
  })

  it('formatLoopEndedSummary for objective_met', () => {
    const text = formatLoopEndedSummary(baseRun({
      status: 'ended',
      endReason: 'objective_met',
      lastVerification: {
        at: Date.now(),
        met: true,
        summary: '回归绿了',
      },
    }))
    expect(text).toContain('达标结束')
    expect(text).toContain('修好登录')
    expect(text).toContain('回归绿了')
  })
})
