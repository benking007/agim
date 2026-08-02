import { describe, expect, it } from 'bun:test'
import {
  DEEPSEEK_THINKING_LEVEL_MAP,
  hashDeepSeekUserId,
  withDeepSeekUserId,
} from './deepseek-compat.js'

describe('deepseek-compat', () => {
  it('maps Agim thinking chips onto official V4 efforts', () => {
    expect(DEEPSEEK_THINKING_LEVEL_MAP.minimal).toBeNull()
    expect(DEEPSEEK_THINKING_LEVEL_MAP.low).toBe('low')
    expect(DEEPSEEK_THINKING_LEVEL_MAP.medium).toBe('high')
    expect(DEEPSEEK_THINKING_LEVEL_MAP.high).toBe('high')
    expect(DEEPSEEK_THINKING_LEVEL_MAP.xhigh).toBe('max')
  })

  it('hashes platform:userId into a safe DeepSeek user_id', () => {
    const a = hashDeepSeekUserId('web', 'alice')
    const b = hashDeepSeekUserId('web', 'alice')
    const c = hashDeepSeekUserId('telegram', 'alice')
    expect(a).toBe(b)
    expect(a).toMatch(/^agim-[a-f0-9]{32}$/)
    expect(a).not.toBe(c)
    expect(hashDeepSeekUserId('', '')).toBeUndefined()
    expect(hashDeepSeekUserId(undefined, undefined)).toBeUndefined()
  })

  it('injects user_id only when missing', () => {
    expect(withDeepSeekUserId({ model: 'deepseek-v4-pro' }, 'agim-abc')).toEqual({
      model: 'deepseek-v4-pro',
      user_id: 'agim-abc',
    })
    expect(withDeepSeekUserId({ user_id: 'keep-me' }, 'agim-abc')).toEqual({
      user_id: 'keep-me',
    })
    expect(withDeepSeekUserId({ model: 'x' }, undefined)).toEqual({ model: 'x' })
  })
})
