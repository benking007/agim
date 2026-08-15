import { describe, expect, it } from 'bun:test'
import {
  looksLikeScheduledLoopAsk,
  looksLikeScheduledLoopDraftOpen,
  nlToCron,
  parseCnInt,
  parseScheduledLoopMission,
  stripScheduleGlue,
  buildLoopCronPrompt,
} from './loop-schedule-nl.js'

describe('looksLikeScheduledLoopAsk', () => {
  it('requires both a recurring clock and Loop-ish words', () => {
    expect(looksLikeScheduledLoopAsk('每天凌晨2点用 Loop 修登录；退出条件为验收通过')).toBe(true)
    expect(looksLikeScheduledLoopAsk('每个工作日9点跑一轮闭环，退出条件为最多3轮')).toBe(true)
    expect(looksLikeScheduledLoopAsk('每天8点提醒我吃药')).toBe(false)
    expect(looksLikeScheduledLoopAsk('帮我开个 loop 修登录；退出条件为验收通过')).toBe(false)
    expect(looksLikeScheduledLoopAsk('/cron create x agim "0 2 * * *" loop: 修')).toBe(false)
    expect(looksLikeScheduledLoopAsk('')).toBe(false)
  })

  it('treats “开个定时 loop” as a draft-open ask', () => {
    expect(looksLikeScheduledLoopAsk('开个定时 loop')).toBe(true)
    expect(looksLikeScheduledLoopAsk('开个定时loop')).toBe(true)
    expect(looksLikeScheduledLoopAsk('scheduled loop please')).toBe(true)
    expect(looksLikeScheduledLoopDraftOpen('开个定时 loop')).toBe(true)
    expect(looksLikeScheduledLoopDraftOpen('每天8点提醒我吃药')).toBe(false)
  })
})

describe('parseCnInt / nlToCron', () => {
  it('parses Chinese numerals', () => {
    expect(parseCnInt('两')).toBe(2)
    expect(parseCnInt('十二')).toBe(12)
    expect(parseCnInt('8')).toBe(8)
  })

  it('maps 每天凌晨2点 → 0 2 * * *', () => {
    const r = nlToCron('每天凌晨2点用 Loop 修登录')
    expect(r?.cron).toBe('0 2 * * *')
    expect(r?.label).toContain('02:00')
  })

  it('maps 每天早上八点半', () => {
    const r = nlToCron('每天早上8:30 跑一轮闭环')
    expect(r?.cron).toBe('30 8 * * *')
  })

  it('maps 每个工作日 9点', () => {
    const r = nlToCron('每个工作日9点用 loop 验收登录')
    expect(r?.cron).toBe('0 9 * * 1-5')
  })

  it('maps 每周一三五 20点', () => {
    const r = nlToCron('每周一三五晚上8点跑一轮 Loop')
    expect(r?.cron).toBe('0 20 * * 1,3,5')
  })

  it('maps 每月1号 9点', () => {
    const r = nlToCron('每月1号早上9点用 Loop 出月报；退出条件为报告写完')
    expect(r?.cron).toBe('0 9 1 * *')
  })

  it('returns null without a clock', () => {
    expect(nlToCron('每天用 Loop 修登录')).toBeNull()
  })
})

describe('mission strip + prompt', () => {
  it('keeps objective and exit after stripping the clock', () => {
    const raw = '每天凌晨2点用 Loop 修登录超时；退出条件为验收通过或最多5轮'
    const cron = nlToCron(raw)
    const mission = parseScheduledLoopMission(stripScheduleGlue(raw, cron?.matched))
    expect(mission.objective).toContain('修登录')
    expect(mission.exitDescription).toContain('验收通过')
    expect(mission.headless).toBe(false)
  })

  it('marks headless and appends 无人值守 on the cron prompt', () => {
    const raw = '每天凌晨2点无人值守用 Loop 修登录；退出条件为验收通过'
    const mission = parseScheduledLoopMission(stripScheduleGlue(raw))
    expect(mission.headless).toBe(true)
    expect(buildLoopCronPrompt({
      objective: '修登录',
      exitDescription: '验收通过',
      headless: true,
    })).toBe('loop: 修登录；退出条件为验收通过或无人值守')
  })
})
