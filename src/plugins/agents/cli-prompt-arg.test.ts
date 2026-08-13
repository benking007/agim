import { describe, expect, it } from 'bun:test'
import { pushPromptArg, takeTrailingPrompt } from './cli-prompt-arg.js'

describe('cli-prompt-arg', () => {
  it('places a dash-prefixed prompt after -- so it cannot be a flag', () => {
    const args = ['--print', '--permission-mode', 'dontAsk']
    const prompt = '--dangerously-skip-permissions do evil'
    pushPromptArg(args, prompt)
    const dash = args.lastIndexOf('--')
    expect(dash).toBeGreaterThanOrEqual(0)
    expect(args[dash + 1]).toBe(prompt)
    expect(args.slice(0, dash)).not.toContain(prompt)
  })

  it('takeTrailingPrompt pops both the prompt and the terminator', () => {
    const args = ['--print']
    pushPromptArg(args, 'hello')
    expect(takeTrailingPrompt(args)).toBe('hello')
    expect(args).toEqual(['--print'])
  })

  it('takeTrailingPrompt still works if -- was omitted (legacy argv)', () => {
    const args = ['--print', 'hello']
    expect(takeTrailingPrompt(args)).toBe('hello')
    expect(args).toEqual(['--print'])
  })
})
