// v1.2.106 — regression guard for the v1.0.14 admin-lockout class of bug:
// a stray `bun test` run clobbering the operator's real ~/.agim/env with the
// admin-bootstrap fixture (IMHUB_ADMIN_USERS=telegram:123). The fix
// (assertEnvWriteAllowed) refuses env-file writes outside the OS tmpdir
// while NODE_ENV=test — independent of the test/setup.ts preload, so it
// holds even when the preload doesn't run.

import { describe, it, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { assertEnvWriteAllowed } from '../../src/cli-ui/env-file.js'

describe('assertEnvWriteAllowed — env-file sandbox guard', () => {
  it('precondition: the test runner sets NODE_ENV=test intrinsically', () => {
    // The whole guard rests on this signal being present without the
    // preload. If a future runner stops setting it, this test fails loudly
    // and we know the guard has gone silent.
    expect(process.env.NODE_ENV).toBe('test')
  })

  it('allows writing inside the OS tmpdir while under test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agim-guard-ok-'))
    expect(() => assertEnvWriteAllowed(join(dir, 'env'))).not.toThrow()
  })

  it('REFUSES writing to the operator real ~/.agim/env while under test', () => {
    // Simulates a botched run where the preload did NOT sandbox AGIM_HOME —
    // the exact v1.0.14 lockout vector. We only CALL the guard with these
    // paths; nothing is written, so the real env is never touched.
    expect(() => assertEnvWriteAllowed('/root/.agim/env')).toThrow(/refusing to write/)
    expect(() => assertEnvWriteAllowed('/home/operator/.agim/env')).toThrow(/NODE_ENV=test/)
  })
})
