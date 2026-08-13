import { describe, it, expect, afterEach } from 'bun:test'
import {
  isExecSandboxConfigured,
  isNativeFsReadRestricted,
  isNativeFsWriteRestricted,
  warnWriteUnconfinedIfSandbox,
  _resetExecutionWorldWarningsForTests,
} from '../../src/core/llm/execution-world.js'

describe('execution-world', () => {
  const ORIG_RESTRICT = process.env.AGIM_NATIVE_FS_RESTRICT
  const ORIG_SANDBOX = process.env.AGIM_EXEC_SANDBOX

  afterEach(() => {
    if (ORIG_RESTRICT === undefined) delete process.env.AGIM_NATIVE_FS_RESTRICT
    else process.env.AGIM_NATIVE_FS_RESTRICT = ORIG_RESTRICT
    if (ORIG_SANDBOX === undefined) delete process.env.AGIM_EXEC_SANDBOX
    else process.env.AGIM_EXEC_SANDBOX = ORIG_SANDBOX
    _resetExecutionWorldWarningsForTests()
  })

  it('sandbox is off when AGIM_EXEC_SANDBOX=off even if bwrap exists', () => {
    process.env.AGIM_EXEC_SANDBOX = 'off'
    expect(isExecSandboxConfigured({ bwrapPresent: true })).toBe(false)
  })

  it('sandbox is on when bwrap is present and not opted out', () => {
    delete process.env.AGIM_EXEC_SANDBOX
    expect(isExecSandboxConfigured({ bwrapPresent: true })).toBe(true)
    expect(isExecSandboxConfigured({ bwrapPresent: false })).toBe(false)
  })

  it('reads restrict only when AGIM_NATIVE_FS_RESTRICT=1', () => {
    delete process.env.AGIM_NATIVE_FS_RESTRICT
    expect(isNativeFsReadRestricted()).toBe(false)
    process.env.AGIM_NATIVE_FS_RESTRICT = '0'
    expect(isNativeFsReadRestricted()).toBe(false)
    process.env.AGIM_NATIVE_FS_RESTRICT = '1'
    expect(isNativeFsReadRestricted()).toBe(true)
  })

  it('writes follow the exec sandbox when restrict is unset', () => {
    delete process.env.AGIM_NATIVE_FS_RESTRICT
    expect(isNativeFsWriteRestricted({ bwrapPresent: true })).toBe(true)
    expect(isNativeFsWriteRestricted({ bwrapPresent: false })).toBe(false)
  })

  it('writes stay unconfined when restrict is explicitly 0', () => {
    process.env.AGIM_NATIVE_FS_RESTRICT = '0'
    expect(isNativeFsWriteRestricted({ bwrapPresent: true })).toBe(false)
  })

  it('writes confine when restrict is 1 even without bwrap', () => {
    process.env.AGIM_NATIVE_FS_RESTRICT = '1'
    expect(isNativeFsWriteRestricted({ bwrapPresent: false })).toBe(true)
  })

  it('warnWriteUnconfinedIfSandbox is a no-op unless restrict=0 and sandbox on', () => {
    delete process.env.AGIM_NATIVE_FS_RESTRICT
    warnWriteUnconfinedIfSandbox({ bwrapPresent: true })
    process.env.AGIM_NATIVE_FS_RESTRICT = '0'
    warnWriteUnconfinedIfSandbox({ bwrapPresent: false })
    warnWriteUnconfinedIfSandbox({ bwrapPresent: true })
  })
})
