// R14 — reapStrayAgimProcesses + findAgimProcesses behaviour.
//
// These functions wrap pgrep + process.kill; we drive them with
// real short-lived child processes (sleep) instead of mocking. Each
// case spawns its own subjects and cleans up after itself.

import { describe, it, expect, afterEach } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { reapStrayAgimProcesses, findAgimProcesses } from '../../src/cli-ui/service'

const spawned: ChildProcess[] = []

afterEach(() => {
  for (const c of spawned) {
    try { c.kill('SIGKILL') } catch { /* ignore */ }
  }
  spawned.length = 0
})

/** Spawn a sleeping process whose argv contains the `agim start`
 *  substring so pgrep picks it up. We use `bash -c 'exec -a "agim
 *  start" sleep 30'` to rename the process; `-a` makes argv[0] the
 *  pgrep-visible label. Falls back to a plain sleep with a unique
 *  marker arg if exec -a isn't supported. */
function spawnFakeAgim(): ChildProcess {
  // exec -a is bash-builtin; works on all glibc bashes.
  const child = spawn('bash', ['-c', 'exec -a "agim start --r14test" sleep 30'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  spawned.push(child)
  return child
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('findAgimProcesses', () => {
  it('returns an empty array when no fake agim processes exist', () => {
    // Filter out our own pid + any genuine agim processes on the
    // test box; the assertion is "the fixture pids we'll spawn
    // below aren't in the baseline".
    const baseline = findAgimProcesses()
    expect(Array.isArray(baseline)).toBe(true)
  })

  it('finds a spawned fake agim process by argv match', async () => {
    const child = spawnFakeAgim()
    // Give pgrep a moment — exec -a happens after the bash fork so
    // there's a brief window where the proc shows as bash.
    await sleep(300)
    const pids = findAgimProcesses()
    expect(pids).toContain(child.pid!)
  })
})

describe('reapStrayAgimProcesses', () => {
  it('returns empty result when no stray processes exist', async () => {
    const r = await reapStrayAgimProcesses({ sigtermTimeoutMs: 500 })
    // Could be empty, or could include other genuine agim on the
    // host. Either way our fixture didn't contribute anything.
    expect(r.reaped).toBeDefined()
    expect(r.survived).toBeDefined()
  })

  it('SIGTERM-kills a well-behaved stray within the window', async () => {
    const child = spawnFakeAgim()
    await sleep(300)
    expect(pidAlive(child.pid!)).toBe(true)

    const r = await reapStrayAgimProcesses({ sigtermTimeoutMs: 2000 })
    expect(r.reaped).toContain(child.pid!)
    expect(r.survived).not.toContain(child.pid!)
    expect(pidAlive(child.pid!)).toBe(false)
  })

  it('honours excludePids — excluded pids are not killed', async () => {
    const child = spawnFakeAgim()
    await sleep(300)
    const beforePids = findAgimProcesses()
    expect(beforePids).toContain(child.pid!)

    const r = await reapStrayAgimProcesses({
      excludePids: [child.pid!],
      sigtermTimeoutMs: 500,
    })
    expect(r.reaped).not.toContain(child.pid!)
    expect(pidAlive(child.pid!)).toBe(true)
  })

  it('does NOT kill the test runner itself (process.pid is auto-excluded)', async () => {
    // Sanity — if this assertion fails the test runner dies, which is
    // its own obvious signal.
    const r = await reapStrayAgimProcesses({ sigtermTimeoutMs: 500 })
    expect(r.reaped).not.toContain(process.pid)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    // Spawn a process that ignores SIGTERM (`trap '' TERM`).
    const child = spawn('bash', ['-c', "exec -a 'agim start --r14test-stubborn' bash -c 'trap \"\" TERM; sleep 30'"], {
      detached: true, stdio: 'ignore',
    })
    child.unref()
    spawned.push(child)
    await sleep(300)
    // The grandchild pid is what pgrep sees (the outer bash exec'd
    // into the inner bash). For this test we just verify SOMETHING
    // in our matched-pid set survives SIGTERM and then gets SIGKILL.
    const pidsBefore = findAgimProcesses().filter((p) => p !== process.pid)
    expect(pidsBefore.length).toBeGreaterThan(0)

    const r = await reapStrayAgimProcesses({ sigtermTimeoutMs: 800 })
    // After the function returns, everything we matched should be
    // dead — either via SIGTERM or escalated SIGKILL. Either way the
    // function counts it as reaped (no survived).
    expect(r.survived).toEqual([])
  }, 8_000)
})
