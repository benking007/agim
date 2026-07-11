// R14 + R15 — reapStrayAgimProcesses + findAgimProcesses behaviour.
//
// R14 introduced the reap helper.
// R15 tightened pgrep to argv-strict /proc scan (Linux) so the reap
//     can't accidentally SIGTERM a bash script whose cmdline contains
//     the literal "agim start". Tests cover both the positive path
//     (real-shape agim is matched) and the regression (shell scripts
//     are NOT matched).

import { describe, it, expect, afterEach } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reapStrayAgimProcesses, findAgimProcesses } from '../../src/cli-ui/service'

const spawned: ChildProcess[] = []
const cleanupDirs: string[] = []

afterEach(() => {
  for (const c of spawned) {
    try { c.kill('SIGKILL') } catch { /* ignore */ }
  }
  spawned.length = 0
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  cleanupDirs.length = 0
})

/** Spawn a process whose argv SHAPE matches real agim:
 *    argv[0] = current node binary (`process.execPath`)
 *    argv[1] = .../cli.js (basename `cli.js` — passes the entry filter)
 *    argv[2] = 'start'
 *  The cli.js body just sleeps + traps SIGTERM so we can verify both
 *  the "well-behaved exit" and "ignored TERM → SIGKILL" branches. */
function spawnFakeAgim(opts: { trapTerm?: boolean } = {}): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), 'agim-reap-fixture-'))
  cleanupDirs.push(dir)
  const cliPath = join(dir, 'cli.js')
  // The trap-term variant emulates a stuck agim that ignores SIGTERM —
  // reap must escalate to SIGKILL. The well-behaved variant exits on
  // first TERM. Both sleep 30s to outlive normal test windows.
  const body = opts.trapTerm
    ? `process.on('SIGTERM',()=>{}); setTimeout(()=>{},30000);`
    : `setTimeout(()=>{},30000);`
  writeFileSync(cliPath, body)
  const child = spawn(process.execPath, [cliPath, 'start'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  spawned.push(child)
  return child
}

/** R15 regression fixture — a plain bash script whose cmdline contains
 *  the literal "agim start" substring. Under the pre-R15 pgrep impl this
 *  would falsely match (operator's test scripts got SIGTERM'd, exit 143).
 *  After R15's argv-strict /proc scan this must NOT show up in
 *  findAgimProcesses(). */
function spawnFakeShellWithAgimString(): ChildProcess {
  const child = spawn('bash', ['-c', 'echo agim start helper ; sleep 30'], {
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
  it('returns an empty array (or only genuine agim) when no fake fixtures spawned', () => {
    const baseline = findAgimProcesses()
    expect(Array.isArray(baseline)).toBe(true)
  })

  it('matches a real-shape fake agim (node + cli.js + start)', async () => {
    const child = spawnFakeAgim()
    await sleep(300)
    const pids = findAgimProcesses()
    expect(pids).toContain(child.pid!)
  })

  // The R15 regression — pre-R15 pgrep matched any process whose
  // cmdline string contained "agim start". A bash script logging or
  // referencing that string got mistakenly listed and then killed.
  it('R15: does NOT match a bash script whose argv contains "agim start" as a literal', async () => {
    const realAgim = spawnFakeAgim()
    const shellOnly = spawnFakeShellWithAgimString()
    await sleep(300)
    const pids = findAgimProcesses()
    expect(pids).toContain(realAgim.pid!)
    expect(pids).not.toContain(shellOnly.pid!)
  })
})

describe('reapStrayAgimProcesses', () => {
  it('returns empty result when no stray processes exist', async () => {
    const r = await reapStrayAgimProcesses({ sigtermTimeoutMs: 500 })
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
    const r = await reapStrayAgimProcesses({
      excludePids: [child.pid!],
      sigtermTimeoutMs: 500,
    })
    expect(r.reaped).not.toContain(child.pid!)
    expect(pidAlive(child.pid!)).toBe(true)
  })

  it('does NOT kill the test runner itself (process.pid is auto-excluded)', async () => {
    const r = await reapStrayAgimProcesses({ sigtermTimeoutMs: 500 })
    expect(r.reaped).not.toContain(process.pid)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const child = spawnFakeAgim({ trapTerm: true })
    await sleep(300)
    expect(pidAlive(child.pid!)).toBe(true)
    await reapStrayAgimProcesses({ sigtermTimeoutMs: 800 })
    // Whether listed under reaped (we ended up killing it via SIGKILL)
    // or survived (kernel still shows it briefly), the function had
    // to escalate. Final state: dead.
    await sleep(200)
    expect(pidAlive(child.pid!)).toBe(false)
  }, 8_000)

  // R15 — companion to the findAgimProcesses regression: reap must
  // NOT touch a bash script with "agim start" in cmdline.
  it('R15: does NOT kill a bash script whose argv contains "agim start" literally', async () => {
    const realAgim = spawnFakeAgim()
    const shellOnly = spawnFakeShellWithAgimString()
    await sleep(300)
    const r = await reapStrayAgimProcesses({ sigtermTimeoutMs: 500 })
    expect(r.reaped).toContain(realAgim.pid!)
    expect(r.reaped).not.toContain(shellOnly.pid!)
    expect(pidAlive(shellOnly.pid!)).toBe(true)
  })
})
