// M-N7 — env-variable aliasing helper.
//
// Most env vars use `IMHUB_*` but a handful of early names landed as
// `IM_HUB_*`. readEnvCompat reads the canonical name first, falls back
// to a deprecated alias with a one-time warn, returns undefined when
// neither is set.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readEnvCompat, _resetEnvCompatWarnings } from '../../src/core/env-compat'

const SAVED: Record<string, string | undefined> = {}
const KEYS = ['IMHUB_FOO', 'IM_HUB_FOO', 'IMHUB_BAR', 'IM_HUB_BAR']

beforeEach(() => {
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k] }
  _resetEnvCompatWarnings()
})

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

describe('readEnvCompat', () => {
  it('returns undefined when neither is set', () => {
    expect(readEnvCompat('IMHUB_FOO', 'IM_HUB_FOO')).toBeUndefined()
  })

  it('returns canonical when only canonical is set', () => {
    process.env.IMHUB_FOO = 'canon'
    expect(readEnvCompat('IMHUB_FOO', 'IM_HUB_FOO')).toBe('canon')
  })

  it('returns alias when only alias is set', () => {
    process.env.IM_HUB_FOO = 'alias'
    expect(readEnvCompat('IMHUB_FOO', 'IM_HUB_FOO')).toBe('alias')
  })

  it('prefers canonical over alias when both are set', () => {
    process.env.IMHUB_FOO = 'canon'
    process.env.IM_HUB_FOO = 'alias'
    expect(readEnvCompat('IMHUB_FOO', 'IM_HUB_FOO')).toBe('canon')
  })

  it('treats empty string as not set (operator may export FOO="")', () => {
    process.env.IMHUB_FOO = ''
    process.env.IM_HUB_FOO = 'alias'
    expect(readEnvCompat('IMHUB_FOO', 'IM_HUB_FOO')).toBe('alias')
  })

  it('supports multiple aliases, walks left-to-right', () => {
    process.env.IM_HUB_BAR = 'mid'
    expect(readEnvCompat('IMHUB_BAR', 'IMHUB_BAR_OLD', 'IM_HUB_BAR')).toBe('mid')
  })

  it('returns undefined when only an unrelated env is set', () => {
    process.env.SOMETHING_ELSE = 'x'
    expect(readEnvCompat('IMHUB_FOO', 'IM_HUB_FOO')).toBeUndefined()
    delete process.env.SOMETHING_ELSE
  })
})
