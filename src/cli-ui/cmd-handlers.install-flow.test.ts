/**
 * Install-flow helpers: credential wipe list + health wait plumbing.
 * Keeps the uninstall `creds` contract honest and documents the
 * post-spawn wait that replaced the fixed 1.5s sleep.
 */

import { describe, expect, it } from 'bun:test'
import { basename } from 'node:path'

const { _internal } = await import('./cmd-handlers.js')

describe('credentialFiles (uninstall creds mode)', () => {
  it('includes bootstrap token file and llm-secrets.json', () => {
    const names = _internal.credentialFiles().map((p) => basename(p))
    expect(names).toContain('web-bootstrap-token')
    expect(names).toContain('llm-secrets.json')
    expect(names).toContain('tokens.json')
  })
})

describe('waitForBackgroundReady', () => {
  it('returns dead immediately when pid is not alive', async () => {
    // PID 1 is usually init and alive; use a deliberately invalid pid.
    const result = await _internal.waitForBackgroundReady(2_147_483_646, {
      timeoutMs: 200,
      pollMs: 50,
    })
    expect(result).toBe('dead')
  })
})
