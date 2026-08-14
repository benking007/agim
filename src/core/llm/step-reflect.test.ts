import { afterEach, describe, expect, it } from 'bun:test'
import {
  actNeedsReflect,
  classifyThinkingStreamEvent,
  extractAssistantText,
  extractAssistantThinking,
  formatStepReflectSteer,
  isStepReflectDisabled,
  isStepReflectEnabled,
  isStepReflectExemptTool,
  mergeStepReflects,
  parseStepReflectFence,
  resolveStepReflectEnv,
  resolveStepReflectThinkingLevel,
  STEP_REFLECT_STEER_PREFIX,
  stepReflectFromThinking,
  summarizeThinkingLine,
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
  it('uses the step-reflect prefix and DeepSeek hop language, not a fence', () => {
    const text = formatStepReflectSteer()
    expect(text.startsWith(STEP_REFLECT_STEER_PREFIX)).toBe(true)
    expect(text).not.toContain('[loop steer]')
    expect(text).toContain('DeepSeek-style')
    expect(text).toContain('think first')
    expect(text).not.toContain('<!-- step-reflect -->')
  })
})

describe('resolveStepReflectThinkingLevel', () => {
  it('forces high when step-reflect is on and /think is off', () => {
    expect(resolveStepReflectThinkingLevel('off', { enabled: true, modelReasoning: true })).toBe('high')
    expect(resolveStepReflectThinkingLevel('minimal', { enabled: true, modelReasoning: true })).toBe('high')
  })

  it('keeps an explicit /think level and does not invent thinking on non-reasoning models', () => {
    expect(resolveStepReflectThinkingLevel('xhigh', { enabled: true, modelReasoning: true })).toBe('xhigh')
    expect(resolveStepReflectThinkingLevel('low', { enabled: true, modelReasoning: true })).toBe('low')
    expect(resolveStepReflectThinkingLevel('off', { enabled: true, modelReasoning: false })).toBe('off')
    expect(resolveStepReflectThinkingLevel('off', { enabled: false, modelReasoning: true })).toBe('off')
  })
})

describe('extractAssistantThinking / stepReflectFromThinking', () => {
  it('joins pi thinking blocks', () => {
    expect(extractAssistantThinking([
      { type: 'thinking', thinking: 'first ' },
      { type: 'text', text: 'visible' },
      { type: 'thinking', thinking: 'second' },
    ])).toBe('first second')
  })

  it('summarizes a long trace into a one-line next', () => {
    const long = 'I should inspect the failing test then patch the parser. '.repeat(4)
    const parsed = stepReflectFromThinking(long)
    expect(parsed?.stance).toBe('keep')
    expect(parsed?.next.endsWith('…')).toBe(true)
    expect(parsed?.next.length).toBeLessThanOrEqual(80)
    expect(summarizeThinkingLine('short plan')).toBe('short plan')
    expect(stepReflectFromThinking('   ')).toBeNull()
  })
})

describe('classifyThinkingStreamEvent', () => {
  it('maps pi thinking stream events', () => {
    expect(classifyThinkingStreamEvent({ type: 'thinking_start' })).toEqual({ kind: 'start' })
    expect(classifyThinkingStreamEvent({ type: 'thinking_delta', delta: 'hmm' })).toEqual({
      kind: 'delta',
      delta: 'hmm',
    })
    expect(classifyThinkingStreamEvent({ type: 'thinking_end' })).toEqual({ kind: 'end' })
    expect(classifyThinkingStreamEvent({ type: 'text_delta', delta: 'hi' })).toBeNull()
    expect(classifyThinkingStreamEvent({ type: 'thinking_delta', delta: '' })).toBeNull()
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

  it('keeps last 3 unique reflects and replaces the same hop `at`', () => {
    const a = { stance: 'keep' as const, next: 'one', at: 1 }
    const b = { stance: 'adjust' as const, next: 'two', at: 2 }
    const c = { stance: 'keep' as const, next: 'three', at: 3 }
    const d = { stance: 'stop' as const, next: 'four', at: 4 }
    expect(mergeStepReflects([a, b, c], [d])).toEqual([b, c, d])
    expect(mergeStepReflects([a], [a])).toEqual([a])
    expect(mergeStepReflects([a], [{ stance: 'keep', next: 'one then two', at: 1 }])).toEqual([
      { stance: 'keep', next: 'one then two', at: 1 },
    ])
  })
})
