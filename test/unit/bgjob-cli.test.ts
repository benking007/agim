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
    const start = run(['start', 'smoke', '--json', '--', 'python3', '-c', 'print("hello-bgjob")'])
    expect(start.status).toBe(0)
    const started = JSON.parse(start.stdout) as { id: string; log: string; ok: boolean }
    expect(started.ok).toBe(true)
    expect(started.id).toContain('smoke')
    expect(started.log).toContain(BGJOBS)

    // Wait for the short command to finish (wrapper writes exit_code + meta).
    let statusJson: { status?: string; exit_code?: number | null } = {}
    for (let i = 0; i < 60; i++) {
      const st = run(['status', started.id, '--json'])
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

    const tail = run(['tail', started.id, '-n', '20'])
    expect(tail.status).toBe(0)
    expect(tail.stdout).toContain('hello-bgjob')
  })

  it('honours BGJOB_ROOT over AGIM_BGJOBS', () => {
    const alt = join(HOME, 'alt-root')
    const r = spawnSync('python3', [SCRIPT, 'start', 'rootpick', '--json', '--', 'true'], {
      env: { ...process.env, AGIM_HOME: HOME, AGIM_BGJOBS: BGJOBS, BGJOB_ROOT: alt },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout ?? '') as { id: string; log: string }
    expect(body.log.startsWith(alt)).toBe(true)
  })

  it('stamps origin from AGIM_ORIGIN_* into meta.json', () => {
    const r = spawnSync('python3', [SCRIPT, 'start', 'bound', '--json', '--', 'true'], {
      env: {
        ...process.env,
        AGIM_HOME: HOME,
        AGIM_BGJOBS: BGJOBS,
        AGIM_ORIGIN_PLATFORM: 'web',
        AGIM_ORIGIN_CHANNEL_ID: '',
        AGIM_ORIGIN_THREAD_ID: 'thread-abc',
        AGIM_ORIGIN_USER_ID: 'web:thread-abc',
      },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout ?? '') as { id: string }
    const meta = JSON.parse(readFileSync(join(BGJOBS, body.id, 'meta.json'), 'utf8')) as {
      origin?: { platform: string; threadId: string }
      notify_on_exit?: boolean
    }
    expect(meta.origin?.platform).toBe('web')
    expect(meta.origin?.threadId).toBe('thread-abc')
    expect(meta.notify_on_exit).toBe(true)
  })
})
