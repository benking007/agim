import { describe, expect, it } from 'vitest'

import { buildAlignPayload } from './portal-loop-align-payload'

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
})
