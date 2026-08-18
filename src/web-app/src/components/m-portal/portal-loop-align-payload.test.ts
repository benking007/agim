import { describe, expect, it } from 'vitest'

import { buildAlignPayload, buildAlignStartFollowUp } from './portal-loop-align-payload'

describe('buildAlignPayload', () => {
  it('includes optional body after exit', () => {
    const msg = buildAlignPayload('修好登录', '最多3轮', '优先查超时日志')
    expect(msg).toBe('/loop 修好登录；退出条件为最多3轮；正文：优先查超时日志')
  })

  it('omits body when empty', () => {
    expect(buildAlignPayload('修好登录', '最多3轮', '  ')).toBe(
      '/loop 修好登录；退出条件为最多3轮',
    )
  })

  it('keeps file-attachment markers in the objective', () => {
    const objective =
      '[文件附件：/root/.agim/media/web/t/req.md (req.md, 13.5 KB)]'
    const msg = buildAlignPayload(objective, '根据2.0升级，至少进行3轮验证', '用 Cursor 落地')
    expect(msg.startsWith(`/loop ${objective}；退出条件为`)).toBe(true)
    expect(msg).toContain('；正文：用 Cursor 落地')
  })
})

describe('buildAlignStartFollowUp', () => {
  it('matches Act Now dispatch nudge (zh)', () => {
    expect(buildAlignStartFollowUp({ zh: true })).toBe(
      '开始：请拆解任务并用 call_agents 派子代理推进本轮，不要自己做调研。',
    )
  })

  it('prefers a CLI worker when provided', () => {
    expect(buildAlignStartFollowUp({ zh: true, preferredWorker: 'codex' })).toContain(
      'agent:"codex"',
    )
  })
})
