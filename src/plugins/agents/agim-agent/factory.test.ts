import { afterEach, describe, expect, it } from 'bun:test'
import {
  NATIVE_TURN_TIMEOUT_MS_DEFAULT,
  resolveRunTimeoutMs,
} from './factory.js'

describe('resolveRunTimeoutMs', () => {
  const prev = process.env.AGIM_NATIVE_TURN_TIMEOUT_MS
  afterEach(() => {
    if (prev === undefined) delete process.env.AGIM_NATIVE_TURN_TIMEOUT_MS
    else process.env.AGIM_NATIVE_TURN_TIMEOUT_MS = prev
  })

  it('defaults to 120 minutes (aligned with A2A)', () => {
    delete process.env.AGIM_NATIVE_TURN_TIMEOUT_MS
    expect(NATIVE_TURN_TIMEOUT_MS_DEFAULT).toBe(2 * 60 * 60 * 1000)
    expect(resolveRunTimeoutMs(undefined)).toBe(NATIVE_TURN_TIMEOUT_MS_DEFAULT)
  })

  it('honors AGIM_NATIVE_TURN_TIMEOUT_MS; 0 disables the watchdog', () => {
    process.env.AGIM_NATIVE_TURN_TIMEOUT_MS = '5000'
    expect(resolveRunTimeoutMs(undefined)).toBe(5000)
    process.env.AGIM_NATIVE_TURN_TIMEOUT_MS = '0'
    expect(resolveRunTimeoutMs(undefined)).toBe(0)
  })
})
