import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureAgimAgentSessionLifecycle,
  findActiveAgimAgentSessionFiles,
  inventoryAndQuarantineOrphans,
  resetAgimAgentSessionLifecycleForTests,
  retireAgimAgentSession,
  sweepQuarantinedSessions,
} from '../../src/core/agim-agent-session-lifecycle.js'

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

function seedJsonl(sessionsRoot: string, sessionId: string, stamp = '2026-07-14T10-00-00-000Z'): string {
  const dir = join(sessionsRoot, encodeCwd(sessionsRoot))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${stamp}_${sessionId}.jsonl`)
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-07-14T10:00:00.000Z',
      cwd: sessionsRoot,
    })}\n`,
    { mode: 0o600 },
  )
  return path
}

describe('agim-agent-session-lifecycle', () => {
  const busy = new Set<string>()
  const invalidated: string[] = []
  let home: string
  let sessionsRoot: string
  let quarantineRoot: string

  afterEach(() => {
    resetAgimAgentSessionLifecycleForTests()
    busy.clear()
    invalidated.length = 0
  })

  function setup(mode: 'on' | 'off' | 'inventory' = 'on'): void {
    home = mkdtempSync(join(tmpdir(), 'agim-life-'))
    sessionsRoot = join(home, 'agim-sessions')
    quarantineRoot = join(home, 'agim-session-quarantine')
    mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 })
    mkdirSync(join(home, 'sessions'), { recursive: true, mode: 0o700 })
    configureAgimAgentSessionLifecycle({
      sessionsRoot,
      quarantineRoot,
      mode,
      quarantineDays: 7,
      sweepIntervalMs: 0,
      retireWaitMs: 50,
      retirePollMs: 5,
      hooks: {
        isBusy: (id) => busy.has(id),
        invalidateCache: (id) => { invalidated.push(id) },
      },
    })
  }

  it('finds active JSONL by session id suffix', () => {
    setup()
    const path = seedJsonl(sessionsRoot, 'web-a-b-1')
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'web-a-b-1')).toEqual([path])
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'missing')).toEqual([])
  })

  it('quarantines JSONL on retire and invalidates cache', async () => {
    setup('on')
    seedJsonl(sessionsRoot, 'web-old-id')
    const result = await retireAgimAgentSession('web-old-id', 'new')
    expect(result).toBe('quarantined')
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'web-old-id')).toEqual([])
    const qFiles = readdirSync(quarantineRoot).filter((n) => n.endsWith('.jsonl'))
    expect(qFiles).toHaveLength(1)
    expect(qFiles[0]).toContain('web-old-id')
    expect(invalidated).toContain('web-old-id')
    if (process.platform !== 'win32') {
      const mode = statSync(join(quarantineRoot, qFiles[0]!)).mode & 0o777
      expect(mode === 0o400 || mode === 0o600).toBe(true)
    }
  })

  it('defers quarantine while session is busy, then succeeds after idle', async () => {
    setup('on')
    seedJsonl(sessionsRoot, 'busy-id')
    busy.add('busy-id')
    const deferred = await retireAgimAgentSession('busy-id', 'new')
    expect(deferred).toBe('deferred')
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'busy-id')).toHaveLength(1)

    busy.delete('busy-id')
    const done = await retireAgimAgentSession('busy-id', 'new')
    expect(done).toBe('quarantined')
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'busy-id')).toEqual([])
  })

  it('inventory mode logs orphans without moving files', async () => {
    setup('inventory')
    seedJsonl(sessionsRoot, 'orphan-1')
    const result = await retireAgimAgentSession('orphan-1', 'orphan')
    expect(result).toBe('skipped')
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'orphan-1')).toHaveLength(1)
    expect(existsSync(quarantineRoot)).toBe(false)
  })

  it('boot inventory quarantines JSONL with no matching Agim meta id', async () => {
    setup('on')
    seedJsonl(sessionsRoot, 'live-id')
    seedJsonl(sessionsRoot, 'orphan-id', '2026-07-14T11-00-00-000Z')
    writeFileSync(
      join(home, 'sessions', 'thread.json'),
      JSON.stringify({ id: 'live-id', agent: 'agim' }),
      'utf-8',
    )
    const summary = await inventoryAndQuarantineOrphans({ home })
    expect(summary.active).toBe(2)
    expect(summary.orphan).toBe(1)
    expect(summary.quarantined).toBe(1)
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'live-id')).toHaveLength(1)
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'orphan-id')).toEqual([])
  })

  it('sweep deletes quarantine files older than grace window', async () => {
    setup('on')
    mkdirSync(quarantineRoot, { recursive: true })
    const oldPath = join(quarantineRoot, '2026-01-01T00-00-00-000Z_old.jsonl')
    writeFileSync(oldPath, '{"type":"session"}\n', 'utf-8')
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    utimesSync(oldPath, past, past)

    const freshPath = join(quarantineRoot, 'fresh.jsonl')
    writeFileSync(freshPath, '{"type":"session"}\n', 'utf-8')

    const { deleted } = await sweepQuarantinedSessions(Date.now())
    expect(deleted).toBe(1)
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(freshPath)).toBe(true)
  })

  it('mode=off skips all retire work', async () => {
    setup('off')
    seedJsonl(sessionsRoot, 'keep-me')
    expect(await retireAgimAgentSession('keep-me', 'new')).toBe('disabled')
    expect(findActiveAgimAgentSessionFiles(sessionsRoot, 'keep-me')).toHaveLength(1)
  })

  it('quarantine root stays outside sessionsRoot (list-safe)', async () => {
    setup('on')
    seedJsonl(sessionsRoot, 'x-id')
    await retireAgimAgentSession('x-id', 'switch')
    // Quarantine must not be a child of sessionsRoot — otherwise
    // JsonlSessionRepo.list() would resurrect the transcript.
    expect(quarantineRoot.startsWith(sessionsRoot + '/')).toBe(false)
    expect(readdirSync(sessionsRoot).some((n) => n.includes('quarantine'))).toBe(false)
    expect(readdirSync(quarantineRoot).some((n) => n.includes('x-id'))).toBe(true)
  })
})