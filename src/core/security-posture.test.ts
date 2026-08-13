import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { formatSecurityPostureLines, getSecurityPosture } from './security-posture.js'

describe('security-posture', () => {
  const saved = {
    sandbox: process.env.AGIM_EXEC_SANDBOX,
    fs: process.env.AGIM_NATIVE_FS_RESTRICT,
    approve: process.env.AGIM_AUTO_APPROVE,
  }

  function restore(): void {
    for (const [k, v] of [
      ['AGIM_EXEC_SANDBOX', saved.sandbox],
      ['AGIM_NATIVE_FS_RESTRICT', saved.fs],
      ['AGIM_AUTO_APPROVE', saved.approve],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }

  it('reports bwrap off when explicitly disabled', () => {
    process.env.AGIM_EXEC_SANDBOX = 'off'
    process.env.AGIM_NATIVE_FS_RESTRICT = '1'
    delete process.env.AGIM_AUTO_APPROVE
    try {
      const p = getSecurityPosture()
      if (existsSync('/usr/bin/bwrap')) expect(p.execSandbox).toBe('off')
      else expect(p.execSandbox).toBe('unavailable')
      expect(p.fsRestrict).toBe(true)
      expect(formatSecurityPostureLines(p).some((l) => /native FS: restricted/.test(l))).toBe(true)
    } finally { restore() }
  })

  it('flags explicit FS unconfine', () => {
    process.env.AGIM_NATIVE_FS_RESTRICT = '0'
    try {
      const p = getSecurityPosture()
      expect(p.fsUnconfineExplicit).toBe(true)
      expect(p.fsRestrict).toBe(false)
      expect(formatSecurityPostureLines(p).some((l) => /EXPLICITLY unconfined/.test(l))).toBe(true)
    } finally { restore() }
  })

  it('labels unset native FS as writes-follow-exec when sandbox is on', () => {
    delete process.env.AGIM_NATIVE_FS_RESTRICT
    delete process.env.AGIM_EXEC_SANDBOX
    try {
      const p = getSecurityPosture()
      expect(p.fsRestrict).toBe(false)
      expect(p.fsUnconfineExplicit).toBe(false)
      if (existsSync('/usr/bin/bwrap')) {
        expect(p.fsWriteRestrict).toBe(true)
        expect(formatSecurityPostureLines(p).some((l) => /writes follow exec sandbox/.test(l))).toBe(true)
      } else {
        expect(p.fsWriteRestrict).toBe(false)
        expect(formatSecurityPostureLines(p).some((l) => /unrestricted \(no exec sandbox/.test(l))).toBe(true)
      }
    } finally { restore() }
  })
})
