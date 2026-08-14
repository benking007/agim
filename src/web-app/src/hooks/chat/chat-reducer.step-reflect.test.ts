import { describe, expect, it } from 'vitest'
import { chatReducer, initialChatState } from './chat-reducer'

describe('STEP_REFLECT_MODE', () => {
  it('defaults on before history arrives', () => {
    expect(initialChatState.stepReflect).toBe(true)
  })

  it('toggles the session flag', () => {
    const on = chatReducer(initialChatState, { kind: 'STEP_REFLECT_MODE', enabled: true })
    expect(on.stepReflect).toBe(true)
    const off = chatReducer(on, { kind: 'STEP_REFLECT_MODE', enabled: false })
    expect(off.stepReflect).toBe(false)
  })

  it('records the ops kill switch', () => {
    const next = chatReducer(initialChatState, {
      kind: 'STEP_REFLECT_MODE',
      enabled: false,
      disabled: true,
    })
    expect(next.stepReflectDisabled).toBe(true)
  })
})
