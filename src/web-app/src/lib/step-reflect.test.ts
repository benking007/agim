import { describe, expect, it } from 'vitest'
import { isAgimFamilyLabel, mergeStepReflects } from './step-reflect'

describe('isAgimFamilyLabel', () => {
  it('matches agim / native and role suffixes', () => {
    expect(isAgimFamilyLabel('agim')).toBe(true)
    expect(isAgimFamilyLabel('agim/cheap')).toBe(true)
    expect(isAgimFamilyLabel('native')).toBe(true)
    expect(isAgimFamilyLabel('claude-code')).toBe(false)
    expect(isAgimFamilyLabel('codex')).toBe(false)
  })
})

describe('mergeStepReflects', () => {
  it('appends and keeps the last 3', () => {
    const a = { stance: 'keep' as const, next: 'one', at: 1 }
    const b = { stance: 'adjust' as const, next: 'two', at: 2 }
    const c = { stance: 'keep' as const, next: 'three', at: 3 }
    const d = { stance: 'stop' as const, next: 'four', at: 4 }
    expect(mergeStepReflects([a, b, c], [d])).toEqual([b, c, d])
  })
})
