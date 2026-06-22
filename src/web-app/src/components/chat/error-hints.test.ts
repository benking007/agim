import { describe, expect, it } from 'vitest'
import { isNativeSetupError } from './error-hints'

describe('isNativeSetupError', () => {
  it('matches native unavailable message from switch-agent WS path', () => {
    const msg = 'Agim Agent is not configured yet. 请先到 /settings/llm 配置一个可用的大模型 API（角色绑定可选），再重试。'
    expect(isNativeSetupError(msg)).toBe(true)
  })

  it('matches legacy native not-available text', () => {
    expect(isNativeSetupError('Agent "native" is not available')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isNativeSetupError('Network disconnected')).toBe(false)
    expect(isNativeSetupError('Agent "codex" is not available')).toBe(false)
  })
})
