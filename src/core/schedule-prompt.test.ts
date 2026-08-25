import { describe, expect, it } from 'bun:test'
import {
  artifactsInstruction,
  parseSchedulePrompt,
  sanitizeArtifactsRel,
  wrapSchedulePrompt,
} from './schedule-prompt.js'

describe('wrapSchedulePrompt / parseSchedulePrompt', () => {
  it('round-trips model and artifacts', () => {
    const wrapped = wrapSchedulePrompt('写日报', {
      model: 'deepseek-v4-pro',
      artifacts: 'PROJECTS/gold-daily',
    })
    expect(wrapped.startsWith('<!-- agim:schedule ')).toBe(true)
    const parsed = parseSchedulePrompt(wrapped)
    expect(parsed.meta.model).toBe('deepseek-v4-pro')
    expect(parsed.meta.artifacts).toBe('PROJECTS/gold-daily')
    expect(parsed.body).toBe('写日报')
  })

  it('omits the prefix when neither model nor artifacts is set', () => {
    expect(wrapSchedulePrompt('hello', {})).toBe('hello')
    expect(parseSchedulePrompt('hello')).toEqual({ meta: {}, body: 'hello' })
  })

  it('strips escaping artifacts paths at wrap time', () => {
    const wrapped = wrapSchedulePrompt('x', { artifacts: '../etc', model: 'm1' })
    const parsed = parseSchedulePrompt(wrapped)
    expect(parsed.meta.model).toBe('m1')
    expect(parsed.meta.artifacts).toBeUndefined()
  })

  it('returns the original body when the prefix JSON is corrupt', () => {
    const raw = '<!-- agim:schedule {not-json} -->\nkeep'
    expect(parseSchedulePrompt(raw).body).toBe(raw)
  })
})

describe('sanitizeArtifactsRel', () => {
  it('accepts nested workspace-relative paths', () => {
    expect(sanitizeArtifactsRel('PROJECTS/gold-daily')).toBe('PROJECTS/gold-daily')
    expect(sanitizeArtifactsRel('a/./b')).toBe('a/b')
  })

  it('rejects absolute, drive, and parent-escape paths', () => {
    expect(sanitizeArtifactsRel('/tmp/out')).toBeNull()
    expect(sanitizeArtifactsRel('C:\\Windows')).toBeNull()
    expect(sanitizeArtifactsRel('../secret')).toBeNull()
    expect(sanitizeArtifactsRel('a/../../b')).toBeNull()
    expect(sanitizeArtifactsRel('')).toBeNull()
  })
})

describe('artifactsInstruction', () => {
  it('mentions the relative path', () => {
    expect(artifactsInstruction('PROJECTS/x', '/ws/PROJECTS/x')).toContain('PROJECTS/x')
  })
})
