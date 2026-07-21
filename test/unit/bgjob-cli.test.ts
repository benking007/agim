// Smoke-test the shipped bin/bgjob against a temp AGIM_HOME / AGIM_BGJOBS tree.

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HOME = mkdtempSync(join(tmpdir(), 'agim-bgjob-cli-'))
const BGJOBS = join(HOME, 'bgjobs')
const SCRIPT = join(process.cwd(), 'bin', 'bgjob')

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    env: { ...process.env, AGIM_HOME: HOME, AGIM_BGJOBS: BGJOBS },
    encoding: 'utf8',
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('bin/bgjob', () => {
  it('starts a detached job, reports status, and lists it', async () => {
    expect(existsSync(SCRIPT)).toBe(true)
    const start = run(['start', 'smoke', '--', 'python3', '-c', 'print("hello-bgjob")'])
    expect(start.status).toBe(0)
    const started = JSON.parse(start.stdout) as { id: string; log: string; ok: boolean }
    expect(started.ok).toBe(true)
    expect(started.id).toContain('smoke')

    // Wait for supervisor to finish the short command.
    let statusJson: { status?: string; exit_code?: number | null } = {}
    for (let i = 0; i < 40; i++) {
      const st = run(['status', started.id])
      expect(st.status).toBe(0)
      statusJson = JSON.parse(st.stdout) as typeof statusJson
      if (statusJson.status === 'completed' || statusJson.status === 'failed') break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(statusJson.status).toBe('completed')
    expect(statusJson.exit_code).toBe(0)

    const log = readFileSync(started.log, 'utf8')
    expect(log).toContain('hello-bgjob')

    const list = run(['list'])
    expect(list.status).toBe(0)
    expect(list.stdout).toContain(started.id)

    const tail = run(['tail', started.id, '--lines', '20'])
    expect(tail.status).toBe(0)
    expect(tail.stdout).toContain('hello-bgjob')
  })
})
