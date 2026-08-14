import { afterEach, describe, expect, it } from 'bun:test'
import {
  actNeedsReflect,
  extractAssistantText,
  formatStepReflectSteer,
  isStepReflectDisabled,
  isStepReflectEnabled,
  isStepReflectExemptTool,
  mergeStepReflects,
  parseStepReflectFence,
  resolveStepReflectEnv,
  STEP_REFLECT_STEER_PREFIX,
} from './step-reflect.js'

afterEach(() => {
  delete process.env.AGIM_STEP_REFLECT
})

describe('resolveStepReflectEnv', () => {
  it('defaults to off', () => {
    expect(resolveStepReflectEnv()).toBe('off')
    expect(isStepReflectEnabled()).toBe(false)
    expect(isStepReflectDisabled()).toBe(false)
  })

  it('reads on / disabled', () => {
    process.env.AGIM_STEP_REFLECT = 'on'
    expect(resolveStepReflectEnv()).toBe('on')
    expect(isStepReflectEnabled()).toBe(true)
    process.env.AGIM_STEP_REFLECT = 'disabled'
    expect(isStepReflectDisabled()).toBe(true)
    expect(isStepReflectEnabled({ stepReflect: true })).toBe(false)
  })
})

describe('isStepReflectEnabled', () => {
  it('session true/false overrides env=on/off', () => {
    process.env.AGIM_STEP_REFLECT = 'on'
    expect(isStepReflectEnabled({ stepReflect: false })).toBe(false)
    process.env.AGIM_STEP_REFLECT = 'off'
    expect(isStepReflectEnabled({ stepReflect: true })).toBe(true)
    expect(isStepReflectEnabled({})).toBe(false)
  })
})

describe('actNeedsReflect', () => {
  it('skips read / ask / todo / reserved agim_reflect', () => {
    expect(actNeedsReflect(['agim_read_file'])).toBe(false)
    expect(actNeedsReflect(['agim_todo_write'])).toBe(false)
    expect(actNeedsReflect(['mcp__agim__ask_user'])).toBe(false)
    expect(actNeedsReflect(['agim_reflect'])).toBe(false)
    expect(actNeedsReflect(['native_read_file'])).toBe(false)
  })

  it('flags write / exec / call_agent', () => {
    expect(actNeedsReflect(['agim_write_file'])).toBe(true)
    expect(actNeedsReflect(['agim_exec'])).toBe(true)
    expect(actNeedsReflect(['agim_edit_file'])).toBe(true)
    expect(actNeedsReflect(['mcp__agim__call_agent'])).toBe(true)
    expect(actNeedsReflect(['agim_read_file', 'agim_write_file'])).toBe(true)
  })

  it('empty / all-exempt beats do not need reflect', () => {
    expect(actNeedsReflect([])).toBe(false)
    expect(actNeedsReflect(['agim_read_file', 'agim_grep'])).toBe(false)
  })

  it('isStepReflectExemptTool matches todo-gate plus agim_reflect', () => {
    expect(isStepReflectExemptTool('agim_list_dir')).toBe(true)
    expect(isStepReflectExemptTool('agim_reflect')).toBe(true)
    expect(isStepReflectExemptTool('agim_exec')).toBe(false)
  })
})

describe('parseStepReflectFence', () => {
  it('parses a well-formed fence', () => {
    const text = [
      'ok',
      '<!-- step-reflect -->',
      'observed: wrote foo.ts',
      'stance: adjust',
      'next: run tests',
      'risk: flaky',
      '<!-- /step-reflect -->',
      'more',
    ].join('\n')
    expect(parseStepReflectFence(text)).toEqual({
      observed: 'wrote foo.ts',
      stance: 'adjust',
      next: 'run tests',
      risk: 'flaky',
    })
  })

  it('rejects missing stance/next and accepts omitted risk', () => {
    expect(parseStepReflectFence('<!-- step-reflect -->\nstance: keep\n<!-- /step-reflect -->')).toBeNull()
    expect(parseStepReflectFence('<!-- step-reflect -->\nstance: maybe\nnext: x\n<!-- /step-reflect -->')).toBeNull()
    expect(parseStepReflectFence('<!--step-reflect-->\nstance: stop\nnext: halt\n<!--/step-reflect-->')).toEqual({
      observed: '',
      stance: 'stop',
      next: 'halt',
    })
  })
})

describe('formatStepReflectSteer', () => {
  it('uses the step-reflect prefix, not loop steer', () => {
    const text = formatStepReflectSteer()
    expect(text.startsWith(STEP_REFLECT_STEER_PREFIX)).toBe(true)
    expect(text).not.toContain('[loop steer]')
    expect(text).toContain('<!-- step-reflect -->')
  })
})

describe('extractAssistantText / mergeStepReflects', () => {
  it('joins text parts', () => {
    expect(extractAssistantText('plain')).toBe('plain')
    expect(extractAssistantText([
      { type: 'text', text: 'a' },
      { type: 'toolCall', name: 'x' },
      { type: 'text', text: 'b' },
    ])).toBe('a\nb')
  })

  it('keeps last 3 unique reflects', () => {
    const a = { stance: 'keep' as const, next: 'one', at: 1 }
    const b = { stance: 'adjust' as const, next: 'two', at: 2 }
    const c = { stance: 'keep' as const, next: 'three', at: 3 }
    const d = { stance: 'stop' as const, next: 'four', at: 4 }
    expect(mergeStepReflects([a, b, c], [d])).toEqual([b, c, d])
    expect(mergeStepReflects([a], [a])).toEqual([a])
  })
})
