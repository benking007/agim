import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const describeSqlite = process.env.AGIM_TEST_REQUIRE_SQLITE === '1' ? describe : describe.skip
const home = mkdtempSync(join(tmpdir(), 'agim-goals-migration-'))

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describeSqlite('goals schema migration', () => {
  it('adds version and mutation_epoch to a legacy table without data loss', async () => {
    const dbPath = join(home, 'legacy-goals.db')
    const { default: Database } = await import('better-sqlite3')
    const legacy = new Database(dbPath)
    legacy.exec(`
      CREATE TABLE goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        progress_log TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
      );
      INSERT INTO goals (platform, channel_id, thread_id, user_id, title)
      VALUES ('test', 'c', 't', 'u', 'legacy objective');
    `)
    legacy.close()

    process.env.AGIM_GOALS_DB = dbPath
    const goals = await import('../../src/core/goals.js')
    const row = goals.getActiveGoal('test', 'c', 't')
    expect(row?.title).toBe('legacy objective')
    expect(row?.version).toBe(1)
    expect(row?.mutationEpoch).toBe(0)
    expect(row?.evidenceRequired).toBe(false)
    goals.closeGoalsDbForTesting()
  })
})
