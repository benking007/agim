// Test preload — wired in via bunfig.toml `[test] preload`.
//
// Why this exists: several modules (cli-ui/env-file.ts, core/admin-
// bootstrap.ts, core/agim-paths.ts, …) resolve AGIM_HOME at *module
// load* time and cache it as a `const`. If a test then calls a function
// that writes a file (promoteAdmin → updateEnvFile, or the bootstrap
// token writer), the path is anchored to the developer's REAL
// ~/.agim/ or ~/.agim/. We observed `test/unit/admin-bootstrap.test.ts`
// silently overwriting the live env with `AGIM_ADMIN_USERS=telegram:123`
// every time `bun test` ran on a workstation that doubled as the agim
// host — see the v1.0.14 incident: every restart inherited the stale
// fixture as the admin allowlist, locking the actual operator out.
//
// Preload runs BEFORE any test file's top-level imports, so setting
// AGIM_HOME here intercepts the module-level resolution. Every test
// run gets a fresh tmpdir; nothing leaks back to the developer's home.

import { mkdtempSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDnsLookupForTests } from '../src/core/url-guard.js'

const sandbox = mkdtempSync(join(tmpdir(), 'agim-test-'))
process.env.AGIM_HOME = sandbox
// Belt + suspenders: agim-paths.ts also honors AGIM_HOME for legacy
// reasons. Pin both so neither leaks to the real install.
process.env.AGIM_HOME = sandbox

// SSRF checks resolve hostnames. CI (and some developer networks) time out
// on vendor APIs such as api.moonshot.cn / x.com, which flakes
// quick-enable and /api/llm tests. IP literals still map to themselves so
// private-address refusals stay real.
setDnsLookupForTests(async (hostname) => {
  const family = isIP(hostname)
  if (family === 4) return { address: hostname, family: 4 }
  if (family === 6) return { address: hostname, family: 6 }
  return { address: '93.184.216.34', family: 4 }
})

// Tests that purposely care about the env-file should write into the
// sandbox; nothing else should ever see this variable, but cleaning it
// is cheap insurance against fixtures bleeding across files.
delete process.env.AGIM_ADMIN_USERS
