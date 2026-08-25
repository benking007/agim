import { describe, expect, it } from 'vitest'
import {
  cronDailyAt,
  cronEveryMinutes,
  parseSchedulePrompt,
  sanitizeArtifactsRel,
  wrapSchedulePrompt,
} from './schedule-prompt'

describe('schedule prompt prefix', () => {
  it('round-trips model and artifacts', () => {
    const wrapped = wrapSchedulePrompt('briefing', {
      model: 'deepseek-v4-pro',
      artifacts: 'PROJECTS/gold-daily',
    })
    const parsed = parseSchedulePrompt(wrapped)
    expect(parsed.meta).toEqual({
      model: 'deepseek-v4-pro',
      artifacts: 'PROJECTS/gold-daily',
    })
    expect(parsed.body).toBe('briefing')
  })

  it('rejects escaping artifact paths', () => {
    expect(sanitizeArtifactsRel('../etc')).toBeNull()
    expect(wrapSchedulePrompt('x', { artifacts: '../etc' })).toBe('x')
  })
})

describe('cron helpers', () => {
  it('builds every-N-minutes and daily expressions', () => {
    expect(cronEveryMinutes(15)).toBe('*/15 * * * *')
    expect(cronEveryMinutes(0)).toBe('*/1 * * * *')
    expect(cronDailyAt('09:30')).toBe('30 9 * * *')
  })
})
